import type { SupabaseClient } from '@supabase/supabase-js'
import { getTask } from '@/lib/ai/tasks'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'

export type AiTaskResult =
  | { ok: true; data: unknown }
  | { ok: false; status: 400 | 404 | 422 | 502 | 503; error: string }

/**
 * The single execution path for every AI call (used by the API route AND by
 * server actions). Caller must have already authenticated the user.
 */
export async function executeAiTask(
  supabase: SupabaseClient,
  userId: string,
  taskName: string,
  input: unknown,
): Promise<AiTaskResult> {
  const task = getTask(taskName)
  if (!task) return { ok: false, status: 404, error: `Unknown task: ${taskName}` }

  let prompt
  try {
    prompt = task.buildPrompt(input)
  } catch {
    return { ok: false, status: 400, error: 'Invalid input for task' }
  }

  const { data: credential } = await supabase
    .from('ai_credentials').select('encrypted_key').eq('owner_id', userId).maybeSingle()

  let key
  try {
    key = resolveApiKey({
      encryptedByokKey: credential?.encrypted_key ?? null,
      kek: process.env.AI_KEY_ENCRYPTION_SECRET!,
      managedKey: process.env.ANTHROPIC_API_KEY,
    })
  } catch {
    return { ok: false, status: 503, error: 'AI key unavailable' }
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
    return { ok: false, status: 502, error: 'AI provider error' }
  }

  // Tokens are spent the moment the provider returns — meter BEFORE validation.
  await recordUsage(supabase, {
    owner_id: userId,
    task: task.name,
    model: task.model,
    byok: key.byok,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  })

  if (response.stop_reason === 'refusal') {
    return { ok: false, status: 422, error: 'The model declined this request' }
  }

  const text = response.content.find((b) => b.type === 'text')
  let parsed: ReturnType<typeof task.outputSchema.safeParse> | null = null
  if (text && 'text' in text) {
    try {
      parsed = task.outputSchema.safeParse(JSON.parse(text.text))
    } catch {
      // Non-JSON / truncated output — same failure class as a shape mismatch.
    }
  }
  if (!parsed?.success) {
    return { ok: false, status: 502, error: 'Model output failed validation' }
  }

  return { ok: true, data: parsed.data }
}
