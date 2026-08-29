import { and, count, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/db'
import { aiAttempts, aiUsage } from '@/db/schema'
import { getEnv } from '@/lib/env'

/**
 * A managed day is capped by tokens AND by call count: 1000 managed calls in one
 * UTC day is beyond any legitimate use whatever their size, and it is the shape a
 * pure token cap is slowest to catch (many tiny calls).
 */
export const MANAGED_DAILY_CALL_CEILING = 1000

export type AiLimitDecision = { allowed: true } | { allowed: false; error: string }

const TOO_MANY_REQUESTS = 'Too many AI requests — wait a minute and try again'
const PERSONAL_CAP_SPENT =
  "You've used today's included AI capacity — it resets at midnight UTC, " +
  'or you can continue now with your own API key in AI settings'
const SHARED_CAP_SPENT =
  'The shared AI capacity for today is used up — continue with your own API key in AI settings, ' +
  'or try tomorrow'

/** Midnight UTC of the current day — the window every managed cap resets on. */
function utcDayStart(): Date {
  return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
}

/**
 * Managed (non-BYOK) tokens and calls since midnight UTC, summed in Postgres.
 *
 * `::bigint`, never `::int`: sum() over int4 columns is already numeric, and
 * casting a day's tokens back down to int4 raises 22003 the moment the total
 * passes 2^31 — which the whole-platform aggregate below reaches long before any
 * cap does. The 22003 lands in the catch, the guardrail fails open, and the
 * ceiling silently stops existing on exactly the busiest day. postgres-js hands
 * bigint back as a string, so the value is read through Number().
 */
const managedToday = {
  n: count(),
  tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::bigint`,
}

/**
 * Cost guardrails, evaluated at the gateway before any provider call.
 *
 * The per-minute window counts ATTEMPTS (ai_attempts), which the gateway writes
 * before calling this — so the race is one insert wide and a provider failure
 * still costs the caller a slot. The daily token caps read the ai_usage ledger,
 * written only after the provider answers, so a burst can still briefly overshoot
 * them; that slack is acceptable for a spend limit. Every lookup failure fails
 * OPEN (log + allow) — same philosophy as recordUsage.
 */
export async function checkAiLimits(ownerId: string, byok: boolean): Promise<AiLimitDecision> {
  const env = getEnv()

  // Sliding-window request limit — BYOK and managed alike.
  try {
    const windowStart = new Date(Date.now() - 60_000)
    const [row] = await getDb()
      .select({ n: count() })
      .from(aiAttempts)
      .where(and(eq(aiAttempts.ownerId, ownerId), gte(aiAttempts.createdAt, windowStart)))
    if ((row?.n ?? 0) >= env.AI_RATE_LIMIT_PER_MINUTE) {
      return { allowed: false, error: TOO_MANY_REQUESTS }
    }
  } catch (err) {
    console.error('ai rate-limit lookup failed', err)
  }

  // The token caps apply only to managed-key calls (BYOK: their key, their spend).
  if (byok) return { allowed: true }

  const dayStart = utcDayStart()

  try {
    const [row] = await getDb()
      .select(managedToday)
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.ownerId, ownerId),
          eq(aiUsage.byok, false),
          gte(aiUsage.createdAt, dayStart),
        ),
      )
    if (
      row &&
      (Number(row.tokens) >= env.AI_MANAGED_DAILY_TOKEN_CAP || row.n >= MANAGED_DAILY_CALL_CEILING)
    ) {
      return { allowed: false, error: PERSONAL_CAP_SPENT }
    }
  } catch (err) {
    console.error('ai managed-cap lookup failed', err)
  }

  // The same aggregate WITHOUT the owner predicate: one runaway account (or a
  // pool of them) must not be able to spend the whole managed budget, so the
  // shared tier has its own ceiling. BYOK stays available either way.
  try {
    const [row] = await getDb()
      .select(managedToday)
      .from(aiUsage)
      .where(and(eq(aiUsage.byok, false), gte(aiUsage.createdAt, dayStart)))
    if (row && Number(row.tokens) >= env.AI_GLOBAL_DAILY_TOKEN_CAP) {
      return { allowed: false, error: SHARED_CAP_SPENT }
    }
  } catch (err) {
    console.error('ai global-cap lookup failed', err)
  }

  return { allowed: true }
}
