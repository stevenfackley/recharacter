import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { cases } from '@/db/schema'

/**
 * A case id that does not exist, or does not belong to the asking owner. The two
 * are deliberately indistinguishable: telling a stranger that a case id is real
 * but not theirs is itself a disclosure.
 */
export class CaseNotFoundError extends Error {
  constructor(message = 'Case not found') {
    super(message)
    this.name = 'CaseNotFoundError'
  }
}

/**
 * Returns the owner's case, creating one if none exists.
 *
 * `on conflict do nothing` + re-select is the whole race handling: two
 * concurrent requests both attempt the insert, one wins, and both then read the
 * single row the `cases_one_per_owner` index guarantees. No 23505 parsing.
 */
export async function getOrCreateCase(ownerId: string): Promise<{ id: string }> {
  const db = getDb()
  await db.insert(cases).values({ ownerId }).onConflictDoNothing({ target: cases.ownerId })
  const [row] = await db.select().from(cases).where(eq(cases.ownerId, ownerId)).limit(1)
  if (!row) throw new Error('case row vanished immediately after upsert')
  return row
}

/**
 * The authorization check that replaced RLS on every case-scoped write: prove
 * the case belongs to this owner BEFORE touching any child table. Callers must
 * await it first — a child upsert alone would happily attach a row to someone
 * else's case id.
 */
export async function assertCaseOwned(ownerId: string, caseId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.ownerId, ownerId)))
    .limit(1)
  if (!row) throw new CaseNotFoundError()
}
