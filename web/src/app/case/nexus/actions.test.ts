import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Premium-gate transport for shapeAnswer: on a 402 from the gateway (no case
 * unlock, no BYOK), the action redirects to the upgrade page rather than
 * returning a silent { shapedAnswer: null } — the veteran needs to know WHY
 * the phrasing help didn't run.
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
  }),
}))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1', owner_id: 'user-1' }),
}))

vi.mock('@/lib/nexus', () => ({
  KURTA_QUESTIONS: [
    { key: 'q1', column: 'q1_condition', prompt: 'What condition?', explainer: '...' },
  ],
  saveNexusAnswer: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function formWith(text: string) {
  const fd = new FormData()
  fd.set('questionKey', 'q1')
  fd.set('text', text)
  return fd
}

describe('shapeAnswer — premium gate transport', () => {
  test('redirects to /case/upgrade on a 402 from the gateway', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 402, error: 'needs the case unlock or your own API key' })
    const { shapeAnswer } = await import('./actions')

    await expect(
      shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account')),
    ).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade')
  })

  test('a non-402 failure still returns nulls without redirecting', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 503, error: 'AI key unavailable' })
    const { shapeAnswer } = await import('./actions')

    const result = await shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account'))
    expect(result).toEqual({ shapedAnswer: null, gaps: null })
    expect(redirectSpy).not.toHaveBeenCalled()
  })
})
