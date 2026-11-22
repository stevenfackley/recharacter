import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

import { aiFailureCode, runAiTask, type AiTaskFailure } from './run-task'
import type { TaskInput } from './tasks'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const COACHING: TaskInput<'coaching_note'> = { score: 1, band: 'building', topGapLabel: null, collectedLabels: [] }
const STATEMENT: TaskInput<'draft_statement'> = {
  answers: { q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c', q4_outweigh: 'd' },
  branch: 'Army', characterization: 'Honorable', dischargeDate: '2001-01-01', collectedEvidence: [],
}

describe('runAiTask', () => {
  test('passes the call through and returns whatever the gateway resolves', async () => {
    const ok = { ok: true, data: { note: 'fixture' } }
    mockExecute.mockResolvedValueOnce(ok)
    await expect(runAiTask('owner-1', 'coaching_note', COACHING)).resolves.toBe(ok)
    expect(mockExecute).toHaveBeenCalledWith('owner-1', 'coaching_note', COACHING)

    const refused = { ok: false, status: 402, error: 'needs the unlock' }
    mockExecute.mockResolvedValueOnce(refused)
    await expect(runAiTask('owner-1', 'draft_statement', STATEMENT)).resolves.toBe(refused)
  })

  test('a gateway rejection resolves as a 503 and logs only the message, never the input', async () => {
    mockExecute.mockRejectedValueOnce(new Error('ai_attempts insert failed'))
    const result = await runAiTask('owner-1', 'shape_nexus_answer', {
      questionKey: 'q1', questionPrompt: 'Fixture?', rawNarrative: 'FIXTURE-PRIVATE-TEXT',
    })

    expect(result).toEqual({ ok: false, status: 503, error: 'AI unavailable' })
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith('ai task shape_nexus_answer failed:', 'ai_attempts insert failed')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('FIXTURE-PRIVATE-TEXT')
  })

  test('a non-Error rejection is logged as-is', async () => {
    mockExecute.mockRejectedValueOnce('boom')
    await expect(runAiTask('owner-1', 'ping', { message: 'hi' })).resolves.toMatchObject({ ok: false, status: 503 })
    expect(console.error).toHaveBeenCalledWith('ai task ping failed:', 'boom')
  })

  test('task names, inputs and outputs are checked at compile time', () => {
    // Never run: tsc fails the build if any line marked @ts-expect-error compiles.
    const typeChecks = async () => {
      // @ts-expect-error not a registered task
      await runAiTask('owner-1', 'draft_anything_you_want', {})
      // @ts-expect-error coaching_note needs band, topGapLabel and collectedLabels
      await runAiTask('owner-1', 'coaching_note', { score: 1 })
      // @ts-expect-error the extraction only takes the four sniffable document types
      await runAiTask('owner-1', 'extract_service_facts', { documentBase64: 'x', mediaType: 'text/html' })
      const r = await runAiTask('owner-1', 'draft_cover_letter', {
        boardName: 'Fixture Board', form: 'DD293', branch: 'Navy',
        characterization: 'Honorable', conditionSummary: 'fixture',
      })
      if (r.ok) {
        const letter: string = r.data.letter
        // @ts-expect-error the cover letter's output has no statement
        void r.data.statement
        void letter
      }
    }
    expect(typeof typeChecks).toBe('function')
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
