import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

import { aiFailureCode, runAiTask, type AiTaskFailure } from './run-task'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('runAiTask', () => {
  test('passes the call through and returns whatever the gateway resolves', async () => {
    const ok = { ok: true, data: { note: 'fixture' } }
    mockExecute.mockResolvedValueOnce(ok)
    await expect(runAiTask('owner-1', 'coaching_note', { score: 1 })).resolves.toBe(ok)
    expect(mockExecute).toHaveBeenCalledWith('owner-1', 'coaching_note', { score: 1 })

    const refused = { ok: false, status: 402, error: 'needs the unlock' }
    mockExecute.mockResolvedValueOnce(refused)
    await expect(runAiTask('owner-1', 'draft_statement', {})).resolves.toBe(refused)
  })

  test('a gateway rejection resolves as a 503 and logs only the message, never the input', async () => {
    mockExecute.mockRejectedValueOnce(new Error('ai_attempts insert failed'))
    const result = await runAiTask('owner-1', 'shape_nexus_answer', { rawNarrative: 'FIXTURE-PRIVATE-TEXT' })

    expect(result).toEqual({ ok: false, status: 503, error: 'AI unavailable' })
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith('ai task shape_nexus_answer failed:', 'ai_attempts insert failed')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('FIXTURE-PRIVATE-TEXT')
  })

  test('a non-Error rejection is logged as-is', async () => {
    mockExecute.mockRejectedValueOnce('boom')
    await expect(runAiTask('owner-1', 'ping', {})).resolves.toMatchObject({ ok: false, status: 503 })
    expect(console.error).toHaveBeenCalledWith('ai task ping failed:', 'boom')
  })
})

describe('aiFailureCode', () => {
  const fail = (status: AiTaskFailure['status'], byokKeyRejected?: boolean): AiTaskFailure =>
    ({ ok: false, status, error: 'x', ...(byokKeyRejected ? { byokKeyRejected } : {}) })

  test.each([
    [fail(503, true), 'byok_key_unreadable'],
    [fail(502, true), 'byok_key_rejected'],
    [fail(429), 'rate_limited'],
    [fail(503), 'ai_unavailable'],
    [fail(502), 'FALLBACK'],
    [fail(400), 'FALLBACK'],
    [fail(404), 'FALLBACK'],
    [fail(422), 'FALLBACK'],
    [fail(402), 'FALLBACK'],
  ])('%j -> %s', (result, expected) => {
    expect(aiFailureCode(result, 'FALLBACK')).toBe(expected)
  })
})
