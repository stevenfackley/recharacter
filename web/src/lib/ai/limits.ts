import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_REQUESTS_PER_MINUTE = 10
const DEFAULT_MANAGED_DAILY_TOKEN_CAP = 2_000_000

/** Positive-integer env override, else the default (unset/garbage falls back). */
function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export type AiLimitDecision = { allowed: true } | { allowed: false; error: string }

/**
 * Cost guardrails, evaluated at the gateway before any provider call. Both checks
 * read the ai_usage ledger, which is written AFTER the provider responds — so a
 * burst of concurrent calls can briefly overshoot a limit. That slack is fine:
 * these limits protect spend, not security, so every lookup failure fails OPEN
 * (log + allow) — same philosophy as recordUsage.
 */
export async function checkAiLimits(
  supabase: SupabaseClient,
  userId: string,
  byok: boolean,
): Promise<AiLimitDecision> {
  // Sliding-window request limit — BYOK and managed alike.
  try {
    const windowStart = new Date(Date.now() - 60_000).toISOString()
    const { count, error } = await supabase
      .from('ai_usage')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .gte('created_at', windowStart)
    if (error) throw error
    if ((count ?? 0) >= limitFromEnv('AI_RATE_LIMIT_PER_MINUTE', DEFAULT_REQUESTS_PER_MINUTE)) {
      return { allowed: false, error: 'Too many AI requests — wait a minute and try again' }
    }
  } catch (err) {
    console.error('ai rate-limit lookup failed', err)
  }

  // Daily token cap applies only to managed-key calls (BYOK: their key, their spend).
  if (byok) return { allowed: true }

  try {
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00Z' // UTC midnight
    const { data, count, error } = await supabase
      .from('ai_usage')
      .select('input_tokens, output_tokens', { count: 'exact' })
      .eq('owner_id', userId)
      .eq('byok', false)
      .gte('created_at', dayStart)
    if (error) throw error
    const rows = data ?? []
    const spent = rows.reduce((sum, r) => sum + r.input_tokens + r.output_tokens, 0)
    // PostgREST returns at most max_rows (supabase/config.toml: 1000) per page, so
    // past that the JS sum silently undercounts — exactly the many-small-calls shape
    // a token cap must catch. A truncated page therefore counts as over-cap: 1000+
    // managed calls in one day is beyond any legitimate use regardless of tokens.
    const truncated = (count ?? rows.length) > rows.length
    if (
      truncated ||
      spent >= limitFromEnv('AI_MANAGED_DAILY_TOKEN_CAP', DEFAULT_MANAGED_DAILY_TOKEN_CAP)
    ) {
      return {
        allowed: false,
        error:
          "You've used today's included AI capacity — it resets at midnight UTC, " +
          'or you can continue now with your own API key in AI settings',
      }
    }
  } catch (err) {
    console.error('ai managed-cap lookup failed', err)
  }

  return { allowed: true }
}
