import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

function post(task: string, body: unknown) {
  return new NextRequest(`http://localhost/api/ai/${task}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callRoute(task: string, body: unknown) {
  const { POST } = await import('@/app/api/ai/[task]/route')
  return POST(post(task, body), { params: Promise.resolve({ task }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-managed-test'
  process.env.AI_KEY_ENCRYPTION_SECRET = Buffer.alloc(32).toString('base64')
  // default: signed-in user with no BYOK credential and successful usage insert
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'ai_credentials') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
    }
    return { insert: async () => ({ error: null }) }
  })
})

describe('POST /api/ai/[task]', () => {
  test('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(401)
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
})
