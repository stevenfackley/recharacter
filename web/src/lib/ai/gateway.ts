import { getTask } from '@/lib/ai/tasks'
import { checkAiLimits } from '@/lib/ai/limits'
import { getEncryptedKey } from '@/lib/ai/credentials'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'
import { isEntitled } from '@/lib/billing'
import { getEnv } from '@/lib/env'

export type AiTaskResult =
  | { ok: true; data: unknown }
  | {
      ok: false
      status: 400 | 402 | 404 | 422 | 429 | 502 | 503
      error: string
      /**
       * True when the user's OWN key is the problem — the provider rejected it
       * (BYOK + 401/403), or it no longer decrypts. Callers must not tell the
       * veteran to "try again": a retry can never succeed until the key is fixed
       * in AI settings (issue #9).
       */
      byokKeyRejected?: boolean
    }

/**
 * The single execution path for every AI call (used by the API route AND by
 * server actions). The caller has already authenticated the user and passes
 * their owner id; every lookup below is scoped to it.
 */
export async function executeAiTask(
  ownerId: string,
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
    const entitled = await isEntitled(ownerId)
    if (!entitled) {
      return { ok: false, status: 402, error: 'This feature needs the case unlock or your own API key' }
    }
  }

  const ciphertext = await getEncryptedKey(ownerId)

  // Guardrails run before key decryption or any provider call. Credential
  // presence is what decides BYOK (mirrors resolveApiKey), so the cap exemption
  // can be judged without touching the key itself.
  const limit = await checkAiLimits(ownerId, Boolean(ciphertext))
  if (!limit.allowed) return { ok: false, status: 429, error: limit.error }

  const env = getEnv()
  if (ciphertext && !env.AI_KEY_ENCRYPTION_SECRET) {
    // Our misconfiguration, not their key: do NOT send them off to re-enter a
    // key that is fine.
    console.error('BYOK credential present but AI_KEY_ENCRYPTION_SECRET is unset')
    return { ok: false, status: 503, error: 'AI key unavailable' }
  }

  let key
  try {
    key = resolveApiKey({
      encryptedByokKey: ciphertext,
      kek: env.AI_KEY_ENCRYPTION_SECRET ?? '',
      // The ciphertext is bound to its owner; decryption under anyone else's id
      // fails rather than yielding a usable key.
      aad: ownerId,
      managedKey: env.ANTHROPIC_API_KEY,
    })
  } catch {
    if (ciphertext) {
      return {
        ok: false,
        status: 503,
        error: 'Your saved API key could not be read — re-enter it in AI settings',
        byokKeyRejected: true,
      }
    }
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
  await recordUsage(ownerId, {
    task: task.name,
    model: task.model,
    byok: key.byok,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
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
