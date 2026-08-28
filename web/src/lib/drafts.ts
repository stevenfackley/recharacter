import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { drafts } from '@/db/schema'
import { assertCaseOwned } from '@/lib/cases'

export type DraftKind = 'personal_statement' | 'cover_letter'

export type Draft = {
  kind: DraftKind
  content: string
  edited: boolean
  generated_at: string
}

/**
 * The regeneration confirm-gate: an EDITED draft is never silently overwritten.
 * Pure so the invariant is directly unit-testable — fresh or machine-only drafts
 * regenerate freely; a draft the veteran touched requires the explicit confirm.
 */
export function regenerateAllowedFor(
  existing: Pick<Draft, 'edited'> | null,
  confirmValue: unknown,
): boolean {
  if (!existing || !existing.edited) return true
  return confirmValue === 'on'
}

export async function getDraft(ownerId: string, caseId: string, kind: DraftKind): Promise<Draft | null> {
  const [row] = await getDb()
    .select({
      kind: drafts.kind,
      content: drafts.content,
      edited: drafts.edited,
      generatedAt: drafts.generatedAt,
    })
    .from(drafts)
    .where(and(eq(drafts.caseId, caseId), eq(drafts.ownerId, ownerId), eq(drafts.kind, kind)))
    .limit(1)
  if (!row) return null
  return {
    // Constrained to the two kinds by drafts_kind_check.
    kind: row.kind as DraftKind,
    content: row.content,
    edited: row.edited,
    generated_at: row.generatedAt.toISOString(),
  }
}

/** Writes a freshly GENERATED draft (resets edited=false). */
export async function saveGeneratedDraft(
  ownerId: string,
  caseId: string,
  kind: DraftKind,
  content: string,
): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const now = new Date()
  const rows = await getDb()
    .insert(drafts)
    .values({ caseId, ownerId, kind, content, edited: false, generatedAt: now })
    .onConflictDoUpdate({
      target: [drafts.caseId, drafts.kind],
      set: { content, edited: false, generatedAt: now, updatedAt: now },
      setWhere: eq(drafts.ownerId, ownerId),
    })
    .returning({ id: drafts.id })
  if (!rows.length) throw new Error('drafts write affected no rows (owner mismatch)')
}

/** Writes the veteran's EDITED text (sets edited=true, preserves generated_at). */
export async function saveEditedDraft(
  ownerId: string,
  caseId: string,
  kind: DraftKind,
  content: string,
): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const rows = await getDb()
    .insert(drafts)
    .values({ caseId, ownerId, kind, content, edited: true })
    .onConflictDoUpdate({
      target: [drafts.caseId, drafts.kind],
      set: { content, edited: true, updatedAt: new Date() },
      setWhere: eq(drafts.ownerId, ownerId),
    })
    .returning({ id: drafts.id })
  // The veteran's own words. Silently discarding them is the worst outcome here.
  if (!rows.length) throw new Error('drafts write affected no rows (owner mismatch)')
}
