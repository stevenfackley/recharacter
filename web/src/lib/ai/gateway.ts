import type { SupabaseClient } from '@supabase/supabase-js'
import { getTask } from '@/lib/ai/tasks'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'
import { isEntitled } from '@/lib/billing'

export type AiTaskResult =
  | { ok: true; data: unknown }
  | {
      ok: false
      status: 400 | 402 | 404 | 422 | 502 | 503
      error: string
      /**
       * True when the provider rejected the user's OWN key (BYOK + 401/403).
       * Callers must not tell the veteran to "try again" — a retry can never
       * succeed until the key is fixed in AI settings (issue #9).
       */
      byokKeyRejected?: boolean
    }

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

  if (task.premium) {
    const entitled = await isEntitled(supabase, userId)
    if (!entitled) {
      return { ok: false, status: 402, error: 'This feature needs the case unlock or your own API key' }
    }
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
      // buildPrompt returns a string OR our own loose content-block shape (vision/PDF
      // tasks) — the cast avoids coupling to the SDK's internal ContentBlockParam type
      // path; the wire shape (what the SDK actually accepts) is what matters here.
      messages: [{ role: 'user', content: prompt as never }],
      output_config: { format: { type: 'json_schema', schema: task.jsonSchema } },
    })
  } catch (err) {
    console.error(`ai task ${task.name} provider error`, err)
    // Anthropic SDK errors carry the provider's HTTP status. 401/403 on a BYOK
    // key means the KEY is bad, not the weather — a permanent failure the
    // veteran can only fix in AI settings. (A managed-key auth failure is an
    // ops problem; the generic message is right for that.)
    const providerStatus = (err as { status?: number }).status
    if (key.byok && (providerStatus === 401 || providerStatus === 403)) {
      return {
        ok: false,
        status: 502,
        error: 'The AI provider rejected your API key — check it in AI settings',
        byokKeyRejected: true,
      }
    }
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
