import { executeAiTask, type AiTaskResult } from '@/lib/ai/gateway'

export type AiTaskFailure = Extract<AiTaskResult, { ok: false }>

/**
 * executeAiTask for a server action: the same result, but it never rejects.
 *
 * The gateway REJECTS (rather than resolving a refusal) when it cannot even
 * record the attempt. An unhandled rejection in an action is a blank 500 on a
 * page the veteran was mid-way through, so that case resolves here as a 503,
 * the same status the gateway gives when AI is unavailable on our side. Only
 * the error message is logged: the input is the veteran's, and none of it goes
 * to a log.
 *
 * It lives beside the gateway rather than in it so the action tests, which
 * stub executeAiTask, still drive this wrapper's catch.
 */
export async function runAiTask(
  ownerId: string, taskName: string, input: unknown,
): Promise<AiTaskResult> {
  try {
    return await executeAiTask(ownerId, taskName, input)
  } catch (err) {
    console.error(`ai task ${taskName} failed:`, err instanceof Error ? err.message : err)
    return { ok: false, status: 503, error: 'AI unavailable' }
  }
}

/**
 * One mapping from a refused AI task to a page's `?error=` CODE. The fallback
 * names the page's own generic failure ('generate_failed', 'extract_failed').
 *
 * The two BYOK failures are deliberately separate codes. A 502 means the
 * provider saw the key and rejected it; a 503 means we could not decrypt what we
 * stored, so the provider never saw anything at all. Both are fixed by
 * re-entering the key and neither is fixed by retrying, but telling a veteran
 * that Anthropic rejected a key Anthropic never received is simply false.
 *
 * A 402 is not mapped: an action that runs a premium task sends it to the
 * upgrade page before asking for a code.
 */
export function aiFailureCode<F extends string>(
  result: AiTaskFailure, fallback: F,
): 'byok_key_unreadable' | 'byok_key_rejected' | 'rate_limited' | 'ai_unavailable' | F {
  if (result.byokKeyRejected) {
    return result.status === 503 ? 'byok_key_unreadable' : 'byok_key_rejected'
  }
  if (result.status === 429) return 'rate_limited'
  if (result.status === 503) return 'ai_unavailable'
  return fallback
}
