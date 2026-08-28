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

vi.mock('@/lib/session', () => ({
  getSessionUser: async () => ({ id: 'user-1', email: null }),
  requireSessionUser: async () => ({ id: 'user-1', email: null }),
}))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1' }),
}))

const mockSaveNexusAnswer = vi.fn()
vi.mock('@/lib/nexus', () => ({
  KURTA_QUESTIONS: [
    { key: 'q1', column: 'q1_condition', prompt: 'What condition?', explainer: '...' },
  ],
  saveNexusAnswer: (...args: unknown[]) => mockSaveNexusAnswer(...args),
}))

const refreshSpy = vi.fn()
vi.mock('next/cache', () => ({
  refresh: () => refreshSpy(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function formWith(text: string) {
  const fd = new FormData()
  fd.set('questionKey', 'q1')
  fd.set('text', text)
  return fd
}

describe('saveAnswer — state-returning save (no redirect)', () => {
  test('saves the answer, refreshes, and reports saved without redirecting', async () => {
    const { saveAnswer } = await import('./actions')

    const result = await saveAnswer({ saved: false, error: null }, formWith('what happened to me'))
    expect(result).toEqual({ saved: true, error: null })
    expect(mockSaveNexusAnswer).toHaveBeenCalledWith('user-1', 'case-1', 'q1', 'what happened to me')
    expect(refreshSpy).toHaveBeenCalled()
    // The old redirect-based save is exactly what discarded unsaved text in the
    // other three textareas (issue #9) — a redirect here is a regression.
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('rejects an over-long answer as inline state, not a redirect', async () => {
    const { saveAnswer } = await import('./actions')

    const result = await saveAnswer({ saved: false, error: null }, formWith('x'.repeat(6001)))
    expect(result).toEqual({ saved: false, error: 'Answer too long (6000 characters max)' })
    expect(mockSaveNexusAnswer).not.toHaveBeenCalled()
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('an unknown question key saves nothing', async () => {
    const { saveAnswer } = await import('./actions')

    const fd = new FormData()
    fd.set('questionKey', 'not-a-question')
    fd.set('text', 'anything')
    const result = await saveAnswer({ saved: false, error: null }, fd)
    expect(result.saved).toBe(false)
    expect(mockSaveNexusAnswer).not.toHaveBeenCalled()
  })

  test('a throwing save is inline state too — never a redirect that discards the other answers', async () => {
    mockSaveNexusAnswer.mockRejectedValueOnce(new Error('case not found'))
    const { saveAnswer } = await import('./actions')

    const result = await saveAnswer({ saved: false, error: null }, formWith('what happened to me'))
    expect(result).toEqual({ saved: false, error: 'Could not save — try again shortly' })
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(redirectSpy).not.toHaveBeenCalled()
  })
})

describe('shapeAnswer — premium gate transport', () => {
  test('a 402 is told in place and names the upgrade page — never a navigation', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 402, error: 'needs the case unlock or your own API key' })
    const { shapeAnswer } = await import('./actions')

    const result = await shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account'))

    expect(result.shapedAnswer).toBeNull()
    expect(result.gaps).toContain('/case/upgrade')
    // Navigating away would discard the other three unsaved answers (issue #9),
    // which is exactly why saveAnswer is state-returning too.
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('a non-402 failure explains itself in place, still no redirect', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 503, error: 'AI key unavailable' })
    const { shapeAnswer } = await import('./actions')

    const result = await shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account'))
    expect(result.shapedAnswer).toBeNull()
    expect(result.gaps).toContain('unavailable')
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('a gateway that rejects outright is inline state, not a 500', async () => {
    mockExecute.mockRejectedValue(new Error('ai_usage attempt insert failed'))
    const { shapeAnswer } = await import('./actions')

    const result = await shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account'))
    expect(result.shapedAnswer).toBeNull()
    expect(result.gaps).toContain('unavailable')
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('the shaping task runs under the signed-in owner id', async () => {
    mockExecute.mockResolvedValue({ ok: true, data: { shapedAnswer: 'shaped', gaps: '' } })
    const { shapeAnswer } = await import('./actions')

    await shapeAnswer({ shapedAnswer: null, gaps: null }, formWith('my raw account'))
    expect(mockExecute.mock.calls[0][0]).toBe('user-1')
    expect(mockExecute.mock.calls[0][1]).toBe('shape_nexus_answer')
  })
})
