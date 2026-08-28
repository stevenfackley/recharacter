import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'
import type { AiLimitDecision } from '@/lib/ai/limits'

/**
 * Gateway ordering. The guardrails, the entitlement check and key resolution
 * each gate the provider call, and the order matters: a refused request must
 * cost nothing — no decryption, no provider round-trip, no metering.
 *
 * The limit RULES themselves (windows, caps, fail-open) are proven against
 * Postgres in tests/ai-scoping.integration.test.ts; here checkAiLimits is a
 * stub, so what is under test is what the gateway does with its verdict.
 */

const realKeyResolution = (opts: { encryptedByokKey: string | null }) =>
  opts.encryptedByokKey
    ? { apiKey: 'byok-key', byok: true }
    : { apiKey: 'managed-key', byok: false }
const mockResolveApiKey = vi.fn(realKeyResolution)
const mockCreate = vi.fn()
vi.mock('@/lib/ai/provider', () => ({
  resolveApiKey: (opts: { encryptedByokKey: string | null }) => mockResolveApiKey(opts),
  createAnthropicClient: () => ({ messages: { create: (...args: unknown[]) => mockCreate(...args) } }),
}))

const mockRecordUsage = vi.fn(async (..._args: unknown[]) => {})
const mockRecordAttempt = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@/lib/ai/usage', () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
  recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
}))

const mockCheckAiLimits = vi.fn(async (..._args: unknown[]): Promise<AiLimitDecision> => ({ allowed: true }))
vi.mock('@/lib/ai/limits', () => ({
  checkAiLimits: (...args: unknown[]) => mockCheckAiLimits(...args),
}))

const mockGetEncryptedKey = vi.fn(async (_ownerId: string): Promise<string | null> => null)
vi.mock('@/lib/ai/credentials', () => ({
  getEncryptedKey: (ownerId: string) => mockGetEncryptedKey(ownerId),
}))

const mockIsEntitled = vi.fn(async (_ownerId: string) => true)
vi.mock('@/lib/billing', () => ({ isEntitled: (ownerId: string) => mockIsEntitled(ownerId) }))

import { executeAiTask } from './gateway'

const OWNER = '11111111-1111-4111-8111-111111111111'
const KEK = Buffer.alloc(32).toString('base64')

const PROVIDER_OK = {
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 7 },
  content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hello' }) }],
}

const runPing = () => executeAiTask(OWNER, 'ping', { message: 'hello' })

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveApiKey.mockImplementation(realKeyResolution)
  mockCreate.mockResolvedValue(PROVIDER_OK)
  mockCheckAiLimits.mockResolvedValue({ allowed: true })
  mockRecordAttempt.mockResolvedValue(undefined)
  mockGetEncryptedKey.mockResolvedValue(null)
  mockIsEntitled.mockResolvedValue(true)
  process.env.ANTHROPIC_API_KEY = 'sk-managed'
  process.env.AI_KEY_ENCRYPTION_SECRET = KEK
  resetEnvForTests()
})

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.AI_KEY_ENCRYPTION_SECRET
  resetEnvForTests()
  vi.restoreAllMocks()
})

describe('task dispatch', () => {
  test('an unregistered task is a 404, and nothing else runs', async () => {
    const result = await executeAiTask(OWNER, 'draft_anything_you_want', {})
    expect(result).toMatchObject({ ok: false, status: 404 })
    expect(mockCheckAiLimits).not.toHaveBeenCalled()
    expect(mockRecordAttempt).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('input the task rejects is a 400 before any spend', async () => {
    const result = await executeAiTask(OWNER, 'ping', { message: 42 })
    expect(result).toMatchObject({ ok: false, status: 400 })
    // A request the task cannot even parse is not an attempt at the model, so it
    // must not consume a rate-limit slot.
    expect(mockRecordAttempt).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('the freemium gate', () => {
  test('a premium task without entitlement is a 402 before any spend', async () => {
    mockIsEntitled.mockResolvedValue(false)
    const result = await executeAiTask(OWNER, 'draft_cover_letter', {
      boardName: 'NDRB', form: 'DD293', branch: 'MarineCorps',
      characterization: 'OtherThanHonorable', conditionSummary: 'adjustment disorder',
    })
    expect(result).toMatchObject({ ok: false, status: 402 })
    expect(mockIsEntitled).toHaveBeenCalledWith(OWNER)
    // Unauthorized for this task: no slot burned, so a veteran who has not paid
    // cannot be rate-limited out of the free tasks by hammering a premium one.
    expect(mockRecordAttempt).not.toHaveBeenCalled()
    expect(mockResolveApiKey).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('a free task never asks about entitlement', async () => {
    await runPing()
    expect(mockIsEntitled).not.toHaveBeenCalled()
  })
})

describe('cost guardrails', () => {
  test('an allowed call goes through and is metered against its owner', async () => {
    const result = await runPing()
    expect(result).toEqual({ ok: true, data: { ok: true, echo: 'hello' } })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockRecordUsage).toHaveBeenCalledWith(OWNER, {
      task: 'ping', model: 'claude-opus-4-8', byok: false, inputTokens: 11, outputTokens: 7,
    })
  })

  test('a refusal is a 429 raised before any key work or provider call', async () => {
    mockCheckAiLimits.mockResolvedValue({ allowed: false, error: 'Too many AI requests — wait a minute and try again' })
    const result = await runPing()
    expect(result).toEqual({
      ok: false, status: 429, error: expect.stringContaining('wait a minute'),
    })
    expect(mockResolveApiKey).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockRecordUsage).not.toHaveBeenCalled()
    // The refused request is still an attempt: a caller cannot buy back slots by
    // continuing to hammer a limiter that is already saying no.
    expect(mockRecordAttempt).toHaveBeenCalledWith(OWNER, 'ping')
  })

  test('the attempt is recorded BEFORE the limiter reads the counter', async () => {
    // The ordering is the fix. Counting after the model call would let N
    // concurrent requests all read the same pre-burst count and all proceed;
    // inserting first narrows the race to the width of one insert.
    await runPing()
    expect(mockRecordAttempt).toHaveBeenCalledTimes(1)
    expect(mockCheckAiLimits).toHaveBeenCalledTimes(1)
    expect(mockRecordAttempt.mock.invocationCallOrder[0])
      .toBeLessThan(mockCheckAiLimits.mock.invocationCallOrder[0])
  })

  test('an attempt that cannot be recorded stops the request instead of running free', async () => {
    mockRecordAttempt.mockRejectedValue(new Error('ai_attempts insert failed'))
    await expect(runPing()).rejects.toThrow('ai_attempts insert failed')
    expect(mockCheckAiLimits).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('BYOK is judged from credential presence alone, without touching the key', async () => {
    mockGetEncryptedKey.mockResolvedValue('enc')
    await runPing()
    expect(mockCheckAiLimits).toHaveBeenCalledWith(OWNER, true)
  })

  test('a managed call reports byok=false to the limiter', async () => {
    await runPing()
    expect(mockCheckAiLimits).toHaveBeenCalledWith(OWNER, false)
  })

  test('BYOK is NOT exempt from a refusal', async () => {
    mockGetEncryptedKey.mockResolvedValue('enc')
    mockCheckAiLimits.mockResolvedValue({ allowed: false, error: 'Too many AI requests — wait a minute and try again' })
    expect(await runPing()).toMatchObject({ ok: false, status: 429 })
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('key resolution', () => {
  test("the owner id is the AAD the ciphertext must authenticate under", async () => {
    mockGetEncryptedKey.mockResolvedValue('enc')
    await runPing()
    expect(mockResolveApiKey).toHaveBeenCalledWith({
      encryptedByokKey: 'enc', kek: KEK, aad: OWNER, managedKey: 'sk-managed',
    })
  })

  test('an unreadable BYOK key is a 503 that never falls back to the managed key', async () => {
    mockGetEncryptedKey.mockResolvedValue('enc')
    mockResolveApiKey.mockImplementation(() => { throw new Error('unsupported state') })
    const result = await runPing()
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: expect.stringContaining('re-enter it in AI settings'),
      byokKeyRejected: true,
    })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('no key at all is a 503 that does NOT blame the veteran', async () => {
    delete process.env.ANTHROPIC_API_KEY
    resetEnvForTests()
    mockResolveApiKey.mockImplementation(() => { throw new Error('No AI key available') })
    const result = await runPing()
    expect(result).toEqual({ ok: false, status: 503, error: 'AI key unavailable' })
    expect((result as { byokKeyRejected?: boolean }).byokKeyRejected).toBeUndefined()
  })

  test('a BYOK credential with no KEK configured is an ops failure, not a bad key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.AI_KEY_ENCRYPTION_SECRET
    resetEnvForTests()
    mockGetEncryptedKey.mockResolvedValue('enc')
    const result = await runPing()
    expect(result).toEqual({ ok: false, status: 503, error: 'AI key unavailable' })
    expect(mockResolveApiKey).not.toHaveBeenCalled()
  })
})

describe('provider failures', () => {
  test("401 on the veteran's own key is flagged as a key problem, not a retry", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetEncryptedKey.mockResolvedValue('enc')
    mockCreate.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }))
    expect(await runPing()).toEqual({
      ok: false,
      status: 502,
      error: expect.stringContaining('rejected your API key'),
      byokKeyRejected: true,
    })
  })

  test('401 on the MANAGED key is an ops problem with the generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreate.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }))
    const result = await runPing()
    expect(result).toEqual({ ok: false, status: 502, error: 'AI provider error' })
    expect((result as { byokKeyRejected?: boolean }).byokKeyRejected).toBeUndefined()
  })

  test('any other provider error is a plain 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }))
    expect(await runPing()).toEqual({ ok: false, status: 502, error: 'AI provider error' })
    expect(mockRecordUsage).not.toHaveBeenCalled()
    // Nothing was metered — but the attempt still stands. A caller that can make
    // the provider fail must not get an unlimited supply of free retries.
    expect(mockRecordAttempt).toHaveBeenCalledTimes(1)
  })
})

describe('response handling', () => {
  test('a refusal is metered and reported as 422 — the tokens were still spent', async () => {
    mockCreate.mockResolvedValue({ ...PROVIDER_OK, stop_reason: 'refusal' })
    expect(await runPing()).toMatchObject({ ok: false, status: 422 })
    expect(mockRecordUsage).toHaveBeenCalledTimes(1)
  })

  test('output that fails the task schema is a 502, still metered', async () => {
    mockCreate.mockResolvedValue({
      ...PROVIDER_OK,
      content: [{ type: 'text', text: JSON.stringify({ wrong: 'shape' }) }],
    })
    expect(await runPing()).toMatchObject({ ok: false, status: 502, error: 'Model output failed validation' })
    expect(mockRecordUsage).toHaveBeenCalledTimes(1)
  })

  test('non-JSON output is the same failure class', async () => {
    mockCreate.mockResolvedValue({ ...PROVIDER_OK, content: [{ type: 'text', text: 'not json' }] })
    expect(await runPing()).toMatchObject({ ok: false, status: 502 })
  })
})
