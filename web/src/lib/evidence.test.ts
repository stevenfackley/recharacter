import { describe, expect, test } from 'vitest'
import {
  EVIDENCE_CATALOG, recommendEvidence, scoreCase,
  type CaseContext, type EvidenceStatusMap,
} from '@/lib/evidence'

const baseContext: CaseContext = {
  conditionCategory: 'adjustment_disorder',
  mstInvolved: false,
  treatedInService: false,
  hasVaRating: false,
}

function statuses(collected: string[]): EvidenceStatusMap {
  return Object.fromEntries(collected.map((k) => [k, 'collected' as const]))
}

describe('recommendEvidence', () => {
  test('always includes the universal items', () => {
    const items = recommendEvidence(baseContext).map((i) => i.type)
    for (const t of ['dd214', 'personal_statement', 'buddy_statement', 'nexus_letter']) {
      expect(items).toContain(t)
    }
  })

  test('service treatment records only when treated in service', () => {
    expect(recommendEvidence(baseContext).map((i) => i.type))
      .not.toContain('service_treatment_records')
    expect(recommendEvidence({ ...baseContext, treatedInService: true }).map((i) => i.type))
      .toContain('service_treatment_records')
  })

  test('VA rating letter only when a rating exists', () => {
    expect(recommendEvidence(baseContext).map((i) => i.type)).not.toContain('va_rating_letter')
    expect(recommendEvidence({ ...baseContext, hasVaRating: true }).map((i) => i.type))
      .toContain('va_rating_letter')
  })

  test('MST context flags the own-testimony guidance on the personal statement', () => {
    const ps = recommendEvidence({ ...baseContext, mstInvolved: true })
      .find((i) => i.type === 'personal_statement')!
    expect(ps.guidance).toMatch(/own (statement|testimony)/i)
  })
})

describe('scoreCase', () => {
  test('zero collected scores 0 and names the nexus letter as the top gap', () => {
    const result = scoreCase(recommendEvidence(baseContext), {})
    expect(result.score).toBe(0)
    expect(result.topGap?.type).toBe('nexus_letter') // highest-weight item
  })

  test('everything collected scores 100 with no gap', () => {
    const rec = recommendEvidence({ ...baseContext, treatedInService: true, hasVaRating: true })
    const result = scoreCase(rec, statuses(rec.map((i) => i.type)))
    expect(result.score).toBe(100)
    expect(result.topGap).toBeNull()
  })

  test('score is proportional to collected weight, not item count', () => {
    const rec = recommendEvidence(baseContext)
    const onlyNexus = scoreCase(rec, statuses(['nexus_letter']))
    const onlyDd214 = scoreCase(rec, statuses(['dd214']))
    expect(onlyNexus.score).toBeGreaterThan(onlyDd214.score)
  })

  test('not_applicable items are excluded from the denominator', () => {
    const rec = recommendEvidence(baseContext)
    const withNA = scoreCase(rec, {
      ...statuses(['nexus_letter']),
      civilian_mh_records: 'not_applicable',
    })
    const withoutNA = scoreCase(rec, statuses(['nexus_letter']))
    expect(withNA.score).toBeGreaterThan(withoutNA.score)
  })

  test('bands: building < 40 <= developing < 75 <= strong', () => {
    const rec = recommendEvidence(baseContext)
    expect(scoreCase(rec, {}).band).toBe('building')
    expect(scoreCase(rec, statuses(rec.map((i) => i.type))).band).toBe('strong')
  })
})
