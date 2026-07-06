import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { CaseContext } from '@/lib/evidence'

export const caseContextSchema = z.object({
  conditionCategory: z.enum(['ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure']),
  mstInvolved: z.boolean(),
  treatedInService: z.boolean(),
  hasVaRating: z.boolean(),
})

export async function getCaseContext(caseId: string): Promise<CaseContext | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('case_context').select('*').eq('case_id', caseId).maybeSingle()
  if (!data) return null
  return {
    conditionCategory: data.condition_category,
    mstInvolved: data.mst_involved,
    treatedInService: data.treated_in_service,
    hasVaRating: data.has_va_rating,
  }
}

export async function saveCaseContext(caseId: string, ctx: CaseContext): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('case_context').upsert(
    {
      case_id: caseId,
      owner_id: user.id,
      condition_category: ctx.conditionCategory,
      mst_involved: ctx.mstInvolved,
      treated_in_service: ctx.treatedInService,
      has_va_rating: ctx.hasVaRating,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}
