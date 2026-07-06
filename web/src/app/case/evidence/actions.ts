'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateCase } from '@/lib/cases'
import { caseContextSchema, getCaseContext, saveCaseContext } from '@/lib/context'
import { executeAiTask } from '@/lib/ai/gateway'
import {
  EVIDENCE_CATALOG, recommendEvidence, scoreCase,
  type EvidenceStatusMap, type EvidenceType,
} from '@/lib/evidence'

export async function saveContext(formData: FormData) {
  const parsed = caseContextSchema.safeParse({
    conditionCategory: String(formData.get('conditionCategory') ?? ''),
    mstInvolved: formData.get('mstInvolved') === 'on',
    treatedInService: formData.get('treatedInService') === 'on',
    hasVaRating: formData.get('hasVaRating') === 'on',
  })
  if (!parsed.success) redirect('/case/evidence?error=' + encodeURIComponent('Check the form'))

  const c = await getOrCreateCase()
  await saveCaseContext(c.id, parsed.data)
  redirect('/case/evidence')
}

const STATUSES = ['needed', 'requested', 'collected', 'not_applicable']

export async function setItemStatus(formData: FormData) {
  const itemType = String(formData.get('itemType') ?? '')
  const status = String(formData.get('status') ?? '')
  if (!STATUSES.includes(status)) redirect('/case/evidence')
  // App-level allowlist symmetric with the status check (the DB check constraint
  // remains the backstop, but a bad type shouldn't read as a transient error).
  if (!(itemType in EVIDENCE_CATALOG)) redirect('/case/evidence')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const { error } = await supabase.from('evidence_items').upsert(
    {
      case_id: c.id, owner_id: user!.id, item_type: itemType,
      status, updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id,item_type' },
  )
  if (error) redirect('/case/evidence?error=' + encodeURIComponent('Could not save — try again'))
  revalidatePath('/case/evidence')
}

/** Optional AI encouragement — renders the DETERMINISTIC score/gap into prose. */
export async function getCoaching(input: {
  score: number; band: 'building' | 'developing' | 'strong'
  topGapLabel: string | null; collectedLabels: string[]
}): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const result = await executeAiTask(supabase, user.id, 'coaching_note', input)
  return result.ok ? (result.data as { note: string }).note : null
}

/**
 * useActionState entry point for "Encourage me". The note returns as the ACTION
 * RESULT and is rendered in place — it never travels through a URL (query strings
 * land in server logs, browser history, and Referer headers; same rule as the
 * intake flow). Inputs are RECOMPUTED server-side rather than read from form
 * fields, so the prompt can't be steered by client-edited hidden inputs.
 */
export async function requestCoaching(
  _prev: { note: string | null },
  _formData: FormData,
): Promise<{ note: string | null }> {
  const c = await getOrCreateCase()
  const ctx = await getCaseContext(c.id)
  if (!ctx) return { note: null }

  const supabase = await createClient()
  const { data: itemRows } = await supabase
    .from('evidence_items').select('item_type, status').eq('case_id', c.id)
  const statuses: EvidenceStatusMap = Object.fromEntries(
    (itemRows ?? []).map((r) => [r.item_type as EvidenceType, r.status]),
  )

  const recommended = recommendEvidence(ctx)
  const result = scoreCase(recommended, statuses)
  const collectedLabels = recommended
    .filter((item) => statuses[item.type] === 'collected')
    .map((item) => item.label)

  const note = await getCoaching({
    score: result.score,
    band: result.band,
    topGapLabel: result.topGap?.label ?? null,
    collectedLabels,
  })
  return { note }
}
