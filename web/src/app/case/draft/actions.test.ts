import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Premium-gate transport for the drafting actions: when the AI gateway refuses a
 * drafting call with 402 (no case unlock, no BYOK), the action redirects to the
 * upgrade page — a friendly path, never a bare error string.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({ eq: async () => ({ data: [] }) }),
    }),
  }),
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1', owner_id: 'user-1' }),
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

const ANSWERS = {
  q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c', q4_outweigh: 'd',
}
vi.mock('@/lib/nexus', () => ({
  getNexusAnswers: async () => ANSWERS,
  answersComplete: () => true,
}))

vi.mock('@/lib/drafts', () => ({
  getDraft: async () => null,
  regenerateAllowedFor: () => true,
  saveGeneratedDraft: vi.fn(),
  saveEditedDraft: vi.fn(),
}))

const ROUTING = {
  recommendedBoard: 'Drb', recommendedForm: 'DD293', boardName: 'NDRB',
  availableBoards: ['Drb', 'Bcmr'], drbDeadline: '2030-04-01', drbWindowOpen: true, flags: [],
}
vi.mock('@/lib/routing', () => ({ routeDischarge: async () => ROUTING }))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/case/draft?error='))
  })

  test('a rejected BYOK key names AI settings instead of suggesting a retry', async () => {
    mockExecute.mockResolvedValue({
      ok: false, status: 502, error: 'The AI provider rejected your API key', byokKeyRejected: true,
    })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    const target = decodeURIComponent(redirectSpy.mock.calls[0][0] as string)
    expect(target).toContain('AI settings')
    // "try again" is a lie for a bad key — a retry can never succeed.
    expect(target).not.toContain('try again')
  })

  test('a transient 502 without the BYOK flag keeps the try-again message', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 502, error: 'AI provider error' })
    const { generateStatement } = await import('./actions')

    await expect(generateStatement(new FormData())).rejects.toThrow()
    const target = decodeURIComponent(redirectSpy.mock.calls[0][0] as string)
    expect(target).toContain('try again shortly')
    expect(target).not.toContain('AI settings')
  })
})
