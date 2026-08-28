import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { caseContext } from '@/db/schema'
import { assertCaseOwned } from '@/lib/cases'
import type { CaseContext } from '@/lib/evidence'

export const caseContextSchema = z.object({
  conditionCategory: z.enum(['ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure']),
  mstInvolved: z.boolean(),
  treatedInService: z.boolean(),
  hasVaRating: z.boolean(),
})

export async function getCaseContext(ownerId: string, caseId: string): Promise<CaseContext | null> {
  const [row] = await getDb()
    .select()
    .from(caseContext)
    .where(and(eq(caseContext.caseId, caseId), eq(caseContext.ownerId, ownerId)))
    .limit(1)
  if (!row) return null
  return {
    // Constrained by case_context_condition_category_check; drizzle sees plain text.
    conditionCategory: row.conditionCategory as CaseContext['conditionCategory'],
    mstInvolved: row.mstInvolved,
    treatedInService: row.treatedInService,
    hasVaRating: row.hasVaRating,
  }
}

export async function saveCaseContext(ownerId: string, caseId: string, ctx: CaseContext): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const columns = {
    conditionCategory: ctx.conditionCategory,
    mstInvolved: ctx.mstInvolved,
    treatedInService: ctx.treatedInService,
    hasVaRating: ctx.hasVaRating,
    updatedAt: new Date(),
  }
  await getDb()
    .insert(caseContext)
    .values({ caseId, ownerId, ...columns })
    .onConflictDoUpdate({
      target: caseContext.caseId,
      set: columns,
      setWhere: eq(caseContext.ownerId, ownerId),
    })
}
