/**
 * The evidence rubric — deterministic and attorney-reviewable (docs/domain/evidence-rubric.md).
 * NO AI in this path: personalization and scoring are pure functions over this data.
 */

export type EvidenceType =
  | 'dd214' | 'service_treatment_records' | 'va_rating_letter' | 'civilian_mh_records'
  | 'buddy_statement' | 'nexus_letter' | 'personal_statement'

export type EvidenceStatus = 'needed' | 'requested' | 'collected' | 'not_applicable'
export type EvidenceStatusMap = Partial<Record<EvidenceType, EvidenceStatus>>

export type CaseContext = {
  conditionCategory: 'ptsd' | 'tbi' | 'depression_anxiety' | 'adjustment_disorder' | 'other_mh' | 'unsure'
  mstInvolved: boolean
  treatedInService: boolean
  hasVaRating: boolean
}

export type EvidenceRecommendation = {
  type: EvidenceType
  label: string
  weight: number
  guidance: string
}

/** Weights sum is irrelevant (score normalizes); RELATIVE size is the rubric. */
export const EVIDENCE_CATALOG: Record<EvidenceType, { label: string; weight: number; guidance: string }> = {
  nexus_letter: {
    label: 'Nexus letter from a mental-health clinician',
    weight: 30,
    guidance:
      'A letter from a mental-health professional connecting your in-service condition to the ' +
      'conduct behind your discharge. The single most persuasive document a petition can include.',
  },
  va_rating_letter: {
    label: 'VA disability rating letter',
    weight: 20,
    guidance: 'Your VA rating decision for the condition — strong corroboration that it exists and is service-connected.',
  },
  service_treatment_records: {
    label: 'Service treatment / in-service mental-health records',
    weight: 15,
    guidance: 'Records from your time in service showing the condition or the events around it.',
  },
  buddy_statement: {
    label: 'Buddy / witness statements',
    weight: 15,
    guidance:
      'Statements from people who saw what happened or saw how you changed. Especially important ' +
      'when the events were unreported or disbelieved at the time.',
  },
  civilian_mh_records: {
    label: 'Civilian mental-health records',
    weight: 10,
    guidance: 'Diagnosis or treatment records from before or after service — they show the trajectory.',
  },
  personal_statement: {
    label: 'Your personal statement',
    weight: 10,
    guidance: 'Your own account, structured around the four questions the board must weigh. Drafted later in this app.',
  },
  dd214: {
    label: 'DD-214 (Certificate of Release or Discharge)',
    weight: 5,
    guidance: 'The baseline document for any petition. You likely already uploaded it during intake.',
  },
}

export function recommendEvidence(ctx: CaseContext): EvidenceRecommendation[] {
  const types: EvidenceType[] = ['dd214', 'personal_statement', 'buddy_statement', 'nexus_letter']
  if (ctx.treatedInService) types.push('service_treatment_records')
  if (ctx.hasVaRating) types.push('va_rating_letter')
  if (ctx.conditionCategory !== 'unsure') types.push('civilian_mh_records')

  return types.map((type) => {
    const base = EVIDENCE_CATALOG[type]
    let guidance = base.guidance
    if (type === 'personal_statement' && ctx.mstInvolved) {
      guidance +=
        ' For MST-related petitions, review boards are directed to accept your own statement as ' +
        'evidence that the experience occurred — the absence of a contemporaneous report does not sink a case.'
    }
    return { type, label: base.label, weight: base.weight, guidance }
  }).sort((a, b) => b.weight - a.weight)
}

export type CaseScore = {
  score: number // 0–100, weight-proportional over applicable items
  band: 'building' | 'developing' | 'strong'
  topGap: EvidenceRecommendation | null
}

export function scoreCase(
  recommended: EvidenceRecommendation[],
  statuses: EvidenceStatusMap,
): CaseScore {
  const applicable = recommended.filter((i) => statuses[i.type] !== 'not_applicable')
  const total = applicable.reduce((s, i) => s + i.weight, 0)
  const collected = applicable
    .filter((i) => statuses[i.type] === 'collected')
    .reduce((s, i) => s + i.weight, 0)

  const score = total === 0 ? 0 : Math.round((collected / total) * 100)
  const band = score >= 75 ? 'strong' : score >= 40 ? 'developing' : 'building'
  const topGap = applicable
    .filter((i) => statuses[i.type] !== 'collected')
    .sort((a, b) => b.weight - a.weight)[0] ?? null

  return { score, band, topGap }
}
