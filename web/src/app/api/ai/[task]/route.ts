import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getTask } from '@/lib/ai/tasks'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'

export async function POST(request: NextRequest, ctx: { params: Promise<{ task: string }> }) {
  const { task: taskName } = await ctx.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const task = getTask(taskName)
  if (!task) return NextResponse.json({ error: `Unknown task: ${taskName}` }, { status: 404 })

  let prompt: string
  try {
    prompt = task.buildPrompt(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid input for task' }, { status: 400 })
  }

  const { data: credential } = await supabase
    .from('ai_credentials').select('encrypted_key').eq('owner_id', user.id).maybeSingle()

  let key
  try {
    key = resolveApiKey({
      encryptedByokKey: credential?.encrypted_key ?? null,
      kek: process.env.AI_KEY_ENCRYPTION_SECRET!,
      managedKey: process.env.ANTHROPIC_API_KEY,
    })
  } catch {
    return NextResponse.json({ error: 'AI key unavailable' }, { status: 503 })
  }

  const client = createAnthropicClient(key.apiKey)

  let response
  try {
    response = await client.messages.create({
      model: task.model,
      max_tokens: task.maxTokens,
      thinking: { type: 'adaptive' },
      system: task.system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: task.jsonSchema } },
    })
  } catch (err) {
    console.error(`ai task ${task.name} provider error`, err)
    return NextResponse.json({ error: 'AI provider error' }, { status: 502 })
  }

  // Tokens are spent the moment the provider returns — meter BEFORE output
  // validation so refusals and invalid outputs still land in the billing ledger.
  await recordUsage(supabase, {
    owner_id: user.id,
    task: task.name,
    model: task.model,
    byok: key.byok,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  })

  if (response.stop_reason === 'refusal') {
    return NextResponse.json({ error: 'The model declined this request' }, { status: 422 })
  }

  const text = response.content.find((b) => b.type === 'text')
  let parsed: ReturnType<typeof task.outputSchema.safeParse> | null = null
  if (text && 'text' in text) {
    try {
      parsed = task.outputSchema.safeParse(JSON.parse(text.text))
    } catch {
      // Non-JSON or truncated output (e.g. a max_tokens cutoff) — same failure
      // class as a shape mismatch; fall through to the 502 below.
    }
  }
  if (!parsed?.success) {
    return NextResponse.json({ error: 'Model output failed validation' }, { status: 502 })
  }

  return NextResponse.json(parsed.data)
}
