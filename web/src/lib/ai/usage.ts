import { count, eq, sql } from 'drizzle-orm'
import { getDb } from '@/db'
import { aiAttempts, aiUsage } from '@/db/schema'

/**
 * Records one ATTEMPTED call, before the guardrails read the counter.
 *
 * Deliberately does NOT swallow, unlike recordUsage: an attempt that cannot be
 * written is an attempt that has not been counted, and running the model anyway
 * would hand a caller an uncounted request every time the insert fails. Nothing
 * has been spent yet at this point, so failing closed costs the veteran only a
 * retry.
 */
export async function recordAttempt(ownerId: string, task: string): Promise<void> {
  await getDb().insert(aiAttempts).values({ ownerId, task })
}

export async function recordUsage(
  ownerId: string,
  u: { task: string; model: string; byok: boolean; inputTokens: number; outputTokens: number },
): Promise<void> {
  // Metering failures must not eat a successful AI response: the tokens are
  // already spent and the veteran already has their answer. Log and continue —
  // the only writer in this module that is allowed to swallow.
  try {
    await getDb().insert(aiUsage).values({
      ownerId,
      task: u.task,
      model: u.model,
      byok: u.byok,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    })
  } catch (err) {
    console.error('ai_usage insert failed', err)
  }
}

/** Lifetime totals for one owner — summed in SQL, never by paging rows into JS. */
export async function usageTotals(
  ownerId: string,
): Promise<{ inputTokens: number; outputTokens: number; calls: number }> {
  const [row] = await getDb()
    .select({
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
      calls: count(),
    })
    .from(aiUsage)
    .where(eq(aiUsage.ownerId, ownerId))
  return row ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
}
