import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetEnvForTests } from '@/lib/env'

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

const mockGetSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: () => mockGetSessionUser(),
}))

// The gateway's own data reads. The route drives the REAL gateway (task
// registry, entitlement gate, key resolution, output validation); only its
// Postgres-backed lookups are stubbed.
const mockGetEncryptedKey = vi.fn()
vi.mock('@/lib/ai/credentials', () => ({
  getEncryptedKey: (...args: unknown[]) => mockGetEncryptedKey(...args),
}))

const mockIsEntitled = vi.fn()
vi.mock('@/lib/billing', () => ({
  isEntitled: (...args: unknown[]) => mockIsEntitled(...args),
}))

const mockRecordUsage = vi.fn()
const mockRecordAttempt = vi.fn()
vi.mock('@/lib/ai/usage', () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
  recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
}))

vi.mock('@/lib/ai/limits', () => ({
  checkAiLimits: vi.fn(async () => ({ allowed: true })),
}))

const OWNER = 'user-1'

function post(task: string, body: unknown) {
  return new NextRequest(`http://localhost/api/ai/${task}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callRoute(task: string, body: unknown) {
  const { POST } = await import('./route')
  return POST(post(task, body), { params: Promise.resolve({ task }) })
}

/** A POST whose body is handed over verbatim — for bodies that are not JSON. */
async function callRouteRaw(task: string, body: string | null) {
  const { POST } = await import('./route')
  const req = new NextRequest(`http://localhost/api/ai/${task}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return POST(req, { params: Promise.resolve({ task }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.ANTHROPIC_API_KEY = 'sk-managed-test'
  process.env.AI_KEY_ENCRYPTION_SECRET = Buffer.alloc(32).toString('base64')
  resetEnvForTests()
  // default: signed-in user with no BYOK credential and no paid unlock —
  // individual premium-gating tests override the entitlement.
  mockGetSessionUser.mockResolvedValue({ id: OWNER, email: null })
  mockGetEncryptedKey.mockResolvedValue(null)
  mockIsEntitled.mockResolvedValue(false)
})

describe('POST /api/ai/[task]', () => {
  test('401 when unauthenticated', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('503 ai_unavailable when the gateway rejects outright, not an unhandled 500', async () => {
    // An attempt the gateway cannot record is a rejection by design — the call
    // must not run unmetered — and the route owns that at its boundary.
    mockRecordAttempt.mockRejectedValueOnce(new Error('attempt could not be recorded'))
    const res = await callRoute('ping', { message: 'hi' })

    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('ai_unavailable')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('404 for a task not in the registry', async () => {
    const res = await callRoute('freeform_legal_advice', { q: 'help' })
    expect(res.status).toBe(404)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('400 for input that fails the task schema', async () => {
    const res = await callRoute('ping', { message: 42 })
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('happy path: calls Claude, validates output, records usage', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hi' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, echo: 'hi' })

    const call = mockCreate.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
    expect(call.output_config.format.type).toBe('json_schema')
    expect(mockRecordUsage).toHaveBeenCalledWith(OWNER, expect.objectContaining({ task: 'ping' }))
  })

  test('the task runs under the SIGNED-IN owner id, not anything from the request', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hi' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    await callRoute('ping', { message: 'hi' })
    expect(mockGetEncryptedKey).toHaveBeenCalledWith(OWNER)
  })

  test('502 when the model output fails schema validation', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ wrong: 'shape' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(502)
  })

  test('422 on refusal stop_reason', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'refusal',
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(422)
  })

  test('ping (non-premium) is unaffected by the entitlement gate even when unentitled', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hi' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/ai/[task] — request parsing', () => {
  test('a body that is not JSON → 400 "Invalid input for task", before the gateway is touched', async () => {
    const res = await callRouteRaw('ping', '{not json')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid input for task' })
    // The gateway never ran: no attempt was counted and no model was called.
    expect(mockRecordAttempt).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('an empty body is the same 400 — request.json() rejects it', async () => {
    const res = await callRouteRaw('ping', null)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid input for task' })
    expect(mockRecordAttempt).not.toHaveBeenCalled()
  })

  test('the malformed-body 400 is indistinguishable from a schema 400', async () => {
    // Same shape either way, so a caller cannot tell "unparseable" from
    // "parsed but refused" — there is nothing to learn from the difference.
    const malformed = await (await callRouteRaw('ping', '{not json')).json()
    const refused = await (await callRoute('ping', { message: 42 })).json()

    expect(malformed).toEqual(refused)
  })

  test('401 wins over a malformed body — an anonymous caller learns nothing about parsing', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRouteRaw('ping', '{not json')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  test('an empty task segment is an unknown task: 404, and nothing is counted or called', async () => {
    const res = await callRoute('', { message: 'hi' })

    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/^Unknown task/)
    expect(mockRecordAttempt).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('the task lookup is exact: case and whitespace variants of a real task are unknown', async () => {
    for (const task of ['PING', 'ping ', ' ping', 'ping/']) {
      const res = await callRoute(task, { message: 'hi' })
      expect(res.status, JSON.stringify(task)).toBe(404)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/ai/[task] — provider auth failures', () => {
  async function mockByokCredential() {
    // A real encrypted credential so resolveApiKey decrypts it and marks byok: true.
    // The AAD is the owner id: a row read for anyone else would not decrypt.
    const { encryptSecret } = await import('@/lib/ai/crypto')
    mockGetEncryptedKey.mockResolvedValue(
      encryptSecret('sk-ant-bad-user-key', process.env.AI_KEY_ENCRYPTION_SECRET!, OWNER),
    )
  }

  test('BYOK + provider 401 → 502 that blames the key, not the weather', async () => {
    await mockByokCredential()
    mockCreate.mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 }))
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('check it in AI settings')
  })

  test('managed key + provider 401 stays a generic provider error', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 }))
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).not.toContain('AI settings')
  })

  test('BYOK + a transient provider failure (529) is NOT blamed on the key', async () => {
    await mockByokCredential()
    mockCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }))
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).not.toContain('AI settings')
  })
})

describe('POST /api/ai/[task] — premium task gating (402)', () => {
  const shapeBody = {
    questionKey: 'q1',
    questionPrompt: 'How did it happen?',
    rawNarrative: 'It happened during a deployment.',
  }

  test('402 for a premium task with no entitlement and no BYOK key; the model is never called', async () => {
    const res = await callRoute('shape_nexus_answer', shapeBody)
    expect(res.status).toBe(402)
    expect(mockCreate).not.toHaveBeenCalled()
    expect((await res.json()).error).toBeTruthy()
  })

  test('an entitled account lets the premium task proceed', async () => {
    mockIsEntitled.mockResolvedValue(true)
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ shapedAnswer: 'During my deployment...', gaps: '' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const res = await callRoute('shape_nexus_answer', shapeBody)
    expect(res.status).toBe(200)
    expect(mockCreate).toHaveBeenCalled()
    expect(mockIsEntitled).toHaveBeenCalledWith(OWNER)
  })
})
