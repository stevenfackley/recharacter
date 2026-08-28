import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { evidenceItems } from '@/db/schema'
import { assertCaseOwned } from '@/lib/cases'
import type { EvidenceStatus, EvidenceStatusMap, EvidenceType } from '@/lib/evidence'

/**
 * Persistence for the evidence checklist. The rubric itself (which items are
 * recommended, how they score) is pure and lives in lib/evidence.ts; only the
 * per-case collection status is stored.
 */

export async function getEvidenceStatuses(ownerId: string, caseId: string): Promise<EvidenceStatusMap> {
  const rows = await getDb()
    .select({ itemType: evidenceItems.itemType, status: evidenceItems.status })
    .from(evidenceItems)
    .where(and(eq(evidenceItems.caseId, caseId), eq(evidenceItems.ownerId, ownerId)))
  // Both columns are constrained to their unions by check constraints.
  return Object.fromEntries(
    rows.map((r) => [r.itemType as EvidenceType, r.status as EvidenceStatus]),
  ) as EvidenceStatusMap
}

export async function setEvidenceStatus(
  ownerId: string,
  caseId: string,
  itemType: EvidenceType,
  status: EvidenceStatus,
): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const rows = await getDb()
    .insert(evidenceItems)
    .values({ caseId, ownerId, itemType, status })
    .onConflictDoUpdate({
      target: [evidenceItems.caseId, evidenceItems.itemType],
      set: { status, updatedAt: new Date() },
      setWhere: eq(evidenceItems.ownerId, ownerId),
    })
    .returning({ id: evidenceItems.id })
  if (!rows.length) throw new Error('evidence_items write affected no rows (owner mismatch)')
}
