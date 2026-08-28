import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Premium-gate and failure transport for the drafting actions: when the AI
 * gateway refuses a drafting call with 402 (no case unlock, no BYOK), the action
 * redirects to the upgrade page — a friendly path, never a bare error string.
 * Every other failure leaves as a CODE the draft page resolves to copy; the
 * distinctions that matter (a broken BYOK key vs a transient provider blip) each
 * get their own code, because one can be retried and the other cannot.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

vi.mock('@/lib/session', () => ({
  requireSessionUser: async () => ({ id: 'user-1', email: null }),
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1' }),
}))

const FACTS = {
  id: 'facts-1', case_id: 'case-1', branch: 'MarineCorps', dischargeDate: '2015-04-01',
  characterization: 'OtherThanHonorable', wasGeneralCourtMartial: false,
  source: 'manual', confirmed: true,
}
vi.mock('@/lib/facts', () => ({ getServiceFacts: async () => FACTS }))

vi.mock('@/lib/context', () => ({
  getCaseContext: async () => ({
    conditionCategory: 'adjustment_disorder', mstInvolved: false,
    treatedInService: false, hasVaRating: false,
  }),
}))

const mockGetEvidenceStatuses = vi.fn(async () => ({}) as Record<string, string>)
vi.mock('@/lib/evidence-items', () => ({
  getEvidenceStatuses: (...args: unknown[]) => mockGetEvidenceStatuses(...(args as [])),
}))

const ANSWERS = {
  q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c', q4_outweigh: 'd',
}
vi.mock('@/lib/nexus', () => ({
  getNexusAnswers: async () => ANSWERS,
  answersComplete: () => true,
}))

const mockSaveGeneratedDraft = vi.fn()
vi.mock('@/lib/drafts', () => ({
  getDraft: async () => null,
  regenerateAllowedFor: () => true,
  saveGeneratedDraft: (...args: unknown[]) => mockSaveGeneratedDraft(...args),
  saveEditedDraft: vi.fn(),
}))

const ROUTING = {
  recommendedBoard: 'Drb', recommendedForm: 'DD293', boardName: 'NDRB',
  availableBoards: ['Drb', 'Bcmr'], drbDeadline: '2030-04-01', drbWindowOpen: true, flags: [],
}
const mockRouteDischarge = vi.fn()
vi.mock('@/lib/routing', () => ({
  routeDischarge: (...args: unknown[]) => mockRouteDischarge(...args),
}))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockGetEvidenceStatuses.mockResolvedValue({})
  mockRouteDischarge.mockResolvedValue(ROUTING)
})

describe('drafting actions — premium gate transport', () => {
  test('generateStatement redirects to /case/upgrade on a 402 from the gateway', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 402, error: 'needs the case unlock or your own API key' })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade')
  })

  test('generateCoverLetter redirects to /case/upgrade on a 402 from the gateway', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 402, error: 'needs the case unlock or your own API key' })
    const { generateCoverLetter } = await import('./actions')

    await expect(generateCoverLetter(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade')
  })

  test('generateStatement still uses the friendly 503 (no key configured) path, not upgrade', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 503, error: 'AI key unavailable' })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=ai_unavailable')
  })

  test('a rejected BYOK key gets its own code (the page names AI settings, not a retry)', async () => {
    mockExecute.mockResolvedValue({
      ok: false, status: 502, error: 'The AI provider rejected your API key', byokKeyRejected: true,
    })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=byok_key_rejected')
  })

  test('a transient 502 without the BYOK flag is the retryable generate_failed code', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 502, error: 'AI provider error' })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=generate_failed')
  })

  test('a throttled call is its own code so the copy can say "wait a minute"', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 429, error: 'Too many AI requests' })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=rate_limited')
  })

  test('an unreachable routing service stops the cover letter before any AI call', async () => {
    mockRouteDischarge.mockRejectedValue(new Error('routing down'))
    const { generateCoverLetter } = await import('./actions')

    await expect(generateCoverLetter(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=routing_unavailable')
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('drafting actions — owner scoping and persistence', () => {
  test('the generated statement is saved owner-scoped, then the page reloads clean', async () => {
    mockExecute.mockResolvedValue({ ok: true, data: { statement: 'My story.' } })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(mockExecute.mock.calls[0][0]).toBe('user-1')
    expect(mockSaveGeneratedDraft).toHaveBeenCalledWith('user-1', 'case-1', 'personal_statement', 'My story.')
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft')
  })

  test('only COLLECTED evidence reaches the drafting prompt', async () => {
    mockGetEvidenceStatuses.mockResolvedValue({ dd214: 'collected', buddy_statement: 'needed' })
    mockExecute.mockResolvedValue({ ok: true, data: { statement: 'My story.' } })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    const input = mockExecute.mock.calls[0][2] as { collectedEvidence: string[] }
    expect(input.collectedEvidence).toHaveLength(1)
  })

  test('a failed save surfaces as save_failed, never as the thrown message', async () => {
    mockExecute.mockResolvedValue({ ok: true, data: { statement: 'My story.' } })
    mockSaveGeneratedDraft.mockRejectedValueOnce(new Error('case not found'))
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/draft?error=save_failed')
  })
})
