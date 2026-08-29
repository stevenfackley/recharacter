'use server'

import { redirect } from 'next/navigation'
import { requireSessionUser } from '@/lib/session'
import { executeAiTask, type AiTaskResult } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getCaseContext } from '@/lib/context'
import { getEvidenceStatuses } from '@/lib/evidence-items'
import { getNexusAnswers, answersComplete } from '@/lib/nexus'
import { EVIDENCE_CATALOG, type EvidenceType } from '@/lib/evidence'
import { getDraft, regenerateAllowedFor, saveGeneratedDraft, saveEditedDraft, type DraftKind } from '@/lib/drafts'
import { routeDischarge } from '@/lib/routing'

const MAX_DRAFT_LENGTH = 50_000
const DRAFT_KINDS = ['personal_statement', 'cover_letter']

const CONDITION_SUMMARY_LABELS: Record<string, string> = {
  ptsd: 'PTSD',
  tbi: 'a traumatic brain injury (TBI)',
  depression_anxiety: 'depression or anxiety',
  adjustment_disorder: 'an adjustment disorder',
  other_mh: 'a mental-health condition',
  unsure: 'a mental-health condition',
}

/** False only when an existing EDITED draft would be silently clobbered without confirm=on. */
async function regenerateAllowed(
  ownerId: string, caseId: string, kind: DraftKind, formData: FormData,
): Promise<boolean> {
  const existing = await getDraft(ownerId, caseId, kind)
  return regenerateAllowedFor(existing, formData.get('confirm'))
}

/**
 * One mapping from a refused AI task to the page's error CODE.
 *
 * The two BYOK failures are deliberately separate codes. A 502 means the
 * provider saw the key and rejected it; a 503 means we could not decrypt what we
 * stored, so the provider never saw anything at all. Both are fixed by
 * re-entering the key and neither is fixed by retrying, but telling a veteran
 * that Anthropic rejected a key Anthropic never received is simply false.
 */
function generateFailureCode(result: Extract<AiTaskResult, { ok: false }>): string {
  if (result.byokKeyRejected) {
    return result.status === 503 ? 'byok_key_unreadable' : 'byok_key_rejected'
  }
  if (result.status === 429) return 'rate_limited'
  if (result.status === 503) return 'ai_unavailable'
  return 'generate_failed'
}

/**
 * The gateway REJECTS (rather than resolving a refusal) when it cannot even
 * record the attempt. Every action that calls it owns that at its own boundary —
 * an unhandled rejection here is a blank 500 on a page the veteran was mid-way
 * through.
 */
async function runTask(
  ownerId: string, taskName: string, input: unknown,
): Promise<AiTaskResult> {
  try {
    return await executeAiTask(ownerId, taskName, input)
  } catch (err) {
    console.error(`ai task ${taskName} failed:`, err instanceof Error ? err.message : err)
    return { ok: false, status: 503, error: 'AI unavailable' }
  }
}

/** Assembles the personal statement exclusively from the four approved Kurta answers. */
export async function generateStatement(formData: FormData) {
  const user = await requireSessionUser('/case/draft')

  const c = await getOrCreateCase(user.id)
  const answers = await getNexusAnswers(user.id, c.id)
  if (!answers || !answersComplete(answers)) redirect('/case/nexus')

  const facts = await getServiceFacts(user.id, c.id)
  if (!facts || !facts.confirmed) redirect('/case/intake')

  if (!(await regenerateAllowed(user.id, c.id, 'personal_statement', formData))) {
    redirect('/case/draft?confirm=statement')
  }

  const statuses = await getEvidenceStatuses(user.id, c.id)
  const collectedEvidence = Object.entries(statuses)
    .filter(([, status]) => status === 'collected')
    .map(([itemType]) => EVIDENCE_CATALOG[itemType as EvidenceType]?.label)
    .filter((label): label is string => Boolean(label))

  const result = await runTask(user.id, 'draft_statement', {
    answers,
    branch: facts.branch,
    characterization: facts.characterization,
    dischargeDate: facts.dischargeDate,
    collectedEvidence,
  })
  if (!result.ok) {
    if (result.status === 402) redirect('/case/upgrade')
    redirect(`/case/draft?error=${generateFailureCode(result)}`)
  }

  const { statement } = result.data as { statement: string }
  try {
    await saveGeneratedDraft(user.id, c.id, 'personal_statement', statement)
  } catch (err) {
    // The failure message only — draft text never goes to a log.
    console.error('statement save failed:', err instanceof Error ? err.message : err)
    redirect('/case/draft?error=save_failed')
  }
  redirect('/case/draft')
}

/** Assembles the cover letter — needs confirmed facts, case context, and a reachable routing service. */
export async function generateCoverLetter(formData: FormData) {
  const user = await requireSessionUser('/case/draft')

  const c = await getOrCreateCase(user.id)
  const facts = await getServiceFacts(user.id, c.id)
  if (!facts || !facts.confirmed) redirect('/case/intake')

  const ctx = await getCaseContext(user.id, c.id)
  if (!ctx) redirect('/case/evidence')

  if (!(await regenerateAllowed(user.id, c.id, 'cover_letter', formData))) {
    redirect('/case/draft?confirm=cover_letter')
  }

  let routing
  try {
    routing = await routeDischarge({
      branch: facts.branch,
      dischargeDate: facts.dischargeDate,
      characterization: facts.characterization,
      wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
    })
  } catch {
    redirect('/case/draft?error=routing_unavailable')
  }

  const conditionSummary =
    `${CONDITION_SUMMARY_LABELS[ctx.conditionCategory] ?? 'a mental-health condition'} arising during service`

  const result = await runTask(user.id, 'draft_cover_letter', {
    boardName: routing.boardName,
    form: routing.recommendedForm,
    branch: facts.branch,
    characterization: facts.characterization,
    conditionSummary,
  })
  if (!result.ok) {
    if (result.status === 402) redirect('/case/upgrade')
    redirect(`/case/draft?error=${generateFailureCode(result)}`)
  }

  const { letter } = result.data as { letter: string }
  try {
    await saveGeneratedDraft(user.id, c.id, 'cover_letter', letter)
  } catch (err) {
    console.error('cover letter save failed:', err instanceof Error ? err.message : err)
    redirect('/case/draft?error=save_failed')
  }
  redirect('/case/draft')
}

/** The veteran's own edits — always allowed, regardless of AI availability. */
export async function saveDraft(formData: FormData) {
  const user = await requireSessionUser('/case/draft')

  const kindRaw = String(formData.get('kind') ?? '')
  if (!DRAFT_KINDS.includes(kindRaw)) redirect('/case/draft')
  const kind = kindRaw as DraftKind

  const content = String(formData.get('content') ?? '')
  if (content.length > MAX_DRAFT_LENGTH) {
    redirect('/case/draft?error=draft_too_long')
  }

  const c = await getOrCreateCase(user.id)
  try {
    await saveEditedDraft(user.id, c.id, kind, content)
  } catch (err) {
    console.error('draft save failed:', err instanceof Error ? err.message : err)
    redirect('/case/draft?error=save_failed')
  }
  redirect('/case/draft')
}
