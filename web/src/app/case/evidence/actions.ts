'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getSessionUser, requireSessionUser } from '@/lib/session'
import { getOrCreateCase } from '@/lib/cases'
import { caseContextSchema, getCaseContext, saveCaseContext } from '@/lib/context'
import { getEvidenceStatuses, setEvidenceStatus } from '@/lib/evidence-items'
import { executeAiTask } from '@/lib/ai/gateway'
import {
  EVIDENCE_CATALOG, recommendEvidence, scoreCase,
  type EvidenceStatus, type EvidenceType,
} from '@/lib/evidence'

export async function saveContext(formData: FormData) {
  const user = await requireSessionUser('/case/evidence')

  const parsed = caseContextSchema.safeParse({
    conditionCategory: String(formData.get('conditionCategory') ?? ''),
    mstInvolved: formData.get('mstInvolved') === 'on',
    treatedInService: formData.get('treatedInService') === 'on',
    hasVaRating: formData.get('hasVaRating') === 'on',
  })
  if (!parsed.success) redirect('/case/evidence?error=invalid_context')

  const c = await getOrCreateCase(user.id)
  try {
    await saveCaseContext(user.id, c.id, parsed.data)
  } catch (err) {
    console.error('case context save failed:', err instanceof Error ? err.message : err)
    redirect('/case/evidence?error=save_failed')
  }
  redirect('/case/evidence')
}

const STATUSES: readonly EvidenceStatus[] = ['needed', 'requested', 'collected', 'not_applicable']

export async function setItemStatus(formData: FormData) {
  // The session first: an unauthenticated caller learns nothing about which
  // item types or statuses this app accepts.
  const user = await requireSessionUser('/case/evidence')

  const itemType = String(formData.get('itemType') ?? '')
  const status = String(formData.get('status') ?? '')
  if (!STATUSES.includes(status as EvidenceStatus)) redirect('/case/evidence')
  // App-level allowlist symmetric with the status check (the DB check constraint
  // remains the backstop, but a bad type shouldn't read as a transient error).
  // `hasOwn`, not `in`: `in` walks the prototype chain, so 'constructor' and
  // 'toString' would pass this guard and fail later against the check
  // constraint — surfacing as save_failed, exactly the transient-looking error
  // this guard exists to prevent.
  if (!Object.hasOwn(EVIDENCE_CATALOG, itemType)) redirect('/case/evidence')

  const c = await getOrCreateCase(user.id)
  try {
    await setEvidenceStatus(user.id, c.id, itemType as EvidenceType, status as EvidenceStatus)
  } catch (err) {
    console.error('evidence status save failed:', err instanceof Error ? err.message : err)
    redirect('/case/evidence?error=save_failed')
  }
  revalidatePath('/case/evidence')
}

/**
 * Optional AI encouragement — renders the DETERMINISTIC score/gap into prose.
 *
 * NOT exported: everything exported from a 'use server' module is a public RPC
 * endpoint, and an exported getCoaching would let a caller supply its own
 * topGapLabel and collectedLabels — exactly the prompt-steering that recomputing
 * the inputs server-side exists to prevent.
 */
async function getCoaching(ownerId: string, input: {
  score: number; band: 'building' | 'developing' | 'strong'
  topGapLabel: string | null; collectedLabels: string[]
}): Promise<string | null> {
  try {
    const result = await executeAiTask(ownerId, 'coaching_note', input)
    return result.ok ? (result.data as { note: string }).note : null
  } catch (err) {
    // The gateway can now reject outright (an attempt it could not record).
    // Encouragement is optional; a missing note is the right outcome, never a 500.
    console.error('coaching note failed:', err instanceof Error ? err.message : err)
    return null
  }
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
  const user = await getSessionUser()
  if (!user) return { note: null }

  const c = await getOrCreateCase(user.id)
  const ctx = await getCaseContext(user.id, c.id)
  if (!ctx) return { note: null }

  const statuses = await getEvidenceStatuses(user.id, c.id)

  const recommended = recommendEvidence(ctx)
  const result = scoreCase(recommended, statuses)
  const collectedLabels = recommended
    .filter((item) => statuses[item.type] === 'collected')
    .map((item) => item.label)

  const note = await getCoaching(user.id, {
    score: result.score,
    band: result.band,
    topGapLabel: result.topGap?.label ?? null,
    collectedLabels,
  })
  return { note }
}
