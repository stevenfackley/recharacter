'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getCaseContext } from '@/lib/context'
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
async function regenerateAllowed(caseId: string, kind: DraftKind, formData: FormData): Promise<boolean> {
  const existing = await getDraft(caseId, kind)
  return regenerateAllowedFor(existing, formData.get('confirm'))
}

/** Assembles the personal statement exclusively from the four approved Kurta answers. */
export async function generateStatement(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const answers = await getNexusAnswers(c.id)
  if (!answers || !answersComplete(answers)) redirect('/case/nexus')

  const facts = await getServiceFacts(c.id)
  if (!facts || !facts.confirmed) redirect('/case/intake')

  if (!(await regenerateAllowed(c.id, 'personal_statement', formData))) {
    redirect('/case/draft?confirm=statement')
  }

  const { data: itemRows } = await supabase
    .from('evidence_items').select('item_type, status').eq('case_id', c.id)
  const collectedEvidence = (itemRows ?? [])
    .filter((r) => r.status === 'collected')
    .map((r) => EVIDENCE_CATALOG[r.item_type as EvidenceType]?.label)
    .filter((label): label is string => Boolean(label))

  const result = await executeAiTask(supabase, user.id, 'draft_statement', {
    answers,
    branch: facts.branch,
    characterization: facts.characterization,
    dischargeDate: facts.dischargeDate,
    collectedEvidence,
  })
  if (!result.ok) {
    if (result.status === 402) redirect('/case/upgrade')
    redirect('/case/draft?error=' + encodeURIComponent(
      result.status === 503
        ? 'Drafting needs an AI key — you can also write your statement directly below'
        : result.byokKeyRejected
          ? 'Your AI provider rejected your API key — check it in AI settings, then generate again'
          : 'Could not generate a statement right now — try again shortly',
    ))
  }

  const { statement } = result.data as { statement: string }
  await saveGeneratedDraft(c.id, 'personal_statement', statement)
  redirect('/case/draft')
}

/** Assembles the cover letter — needs confirmed facts, case context, and a reachable routing service. */
export async function generateCoverLetter(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)
  if (!facts || !facts.confirmed) redirect('/case/intake')

  const ctx = await getCaseContext(c.id)
  if (!ctx) redirect('/case/evidence')

  if (!(await regenerateAllowed(c.id, 'cover_letter', formData))) {
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
    redirect('/case/draft?error=' + encodeURIComponent(
      'The routing service is unavailable right now — try again shortly',
    ))
  }

  const conditionSummary =
    `${CONDITION_SUMMARY_LABELS[ctx.conditionCategory] ?? 'a mental-health condition'} arising during service`

  const result = await executeAiTask(supabase, user.id, 'draft_cover_letter', {
    boardName: routing.boardName,
    form: routing.recommendedForm,
    branch: facts.branch,
    characterization: facts.characterization,
    conditionSummary,
  })
  if (!result.ok) {
    if (result.status === 402) redirect('/case/upgrade')
    redirect('/case/draft?error=' + encodeURIComponent(
      result.status === 503
        ? 'Drafting needs an AI key — you can write your cover letter directly instead'
        : result.byokKeyRejected
          ? 'Your AI provider rejected your API key — check it in AI settings, then generate again'
          : 'Could not generate a cover letter right now — try again shortly',
    ))
  }

  const { letter } = result.data as { letter: string }
  await saveGeneratedDraft(c.id, 'cover_letter', letter)
  redirect('/case/draft')
}

/** The veteran's own edits — always allowed, regardless of AI availability. */
export async function saveDraft(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const kindRaw = String(formData.get('kind') ?? '')
  if (!DRAFT_KINDS.includes(kindRaw)) redirect('/case/draft')
  const kind = kindRaw as DraftKind

  const content = String(formData.get('content') ?? '')
  if (content.length > MAX_DRAFT_LENGTH) {
    redirect('/case/draft?error=' + encodeURIComponent('Draft too long (50,000 characters max)'))
  }

  const c = await getOrCreateCase()
  await saveEditedDraft(c.id, kind, content)
  redirect('/case/draft')
}
