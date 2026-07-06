'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateCase } from '@/lib/cases'
import { caseContextSchema, saveCaseContext } from '@/lib/context'
import { executeAiTask } from '@/lib/ai/gateway'

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

/** Form entry point for "Encourage me" — reads the already-computed score/gap out of
 * hidden form fields (the page renders them), calls getCoaching, and hands the note
 * back via a query param for the page to render. Silent no-op if AI is unavailable. */
export async function requestCoaching(formData: FormData) {
  const score = Number(formData.get('score') ?? 0)
  const bandRaw = String(formData.get('band') ?? 'building')
  const band = (['building', 'developing', 'strong'] as const).includes(bandRaw as never)
    ? (bandRaw as 'building' | 'developing' | 'strong')
    : 'building'
  const topGapLabelRaw = String(formData.get('topGapLabel') ?? '')
  const topGapLabel = topGapLabelRaw === '' ? null : topGapLabelRaw

  let collectedLabels: string[] = []
  try {
    const raw = JSON.parse(String(formData.get('collectedLabels') ?? '[]'))
    if (Array.isArray(raw)) collectedLabels = raw.map(String)
  } catch {
    collectedLabels = []
  }

  const note = await getCoaching({ score, band, topGapLabel, collectedLabels })
  if (note) redirect('/case/evidence?coaching=' + encodeURIComponent(note))
  redirect('/case/evidence')
}
