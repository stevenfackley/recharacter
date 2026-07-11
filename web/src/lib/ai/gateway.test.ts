import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Gateway guardrails: the per-user sliding-window request limit and the
 * managed-tier daily token cap. Both are enforced in executeAiTask BEFORE key
 * resolution and the provider call — a limited request must cost nothing.
 * Lookups fail OPEN (the limiter protects spend, not security).
 */

const mockResolveApiKey = vi.fn((opts: { encryptedByokKey: string | null }) =>
  opts.encryptedByokKey
    ? { apiKey: 'byok-key', byok: true }
    : { apiKey: 'managed-key', byok: false },
)
const mockCreate = vi.fn()
vi.mock('@/lib/ai/provider', () => ({
  resolveApiKey: (opts: { encryptedByokKey: string | null }) => mockResolveApiKey(opts),
  createAnthropicClient: () => ({ messages: { create: (...args: unknown[]) => mockCreate(...args) } }),
}))

const mockRecordUsage = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@/lib/ai/usage', () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}))

vi.mock('@/lib/billing', () => ({ isEntitled: async () => true }))

const PROVIDER_OK = {
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 7 },
  content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hello' }) }],
}

type UsageRow = { input_tokens: number; output_tokens: number }

/**
 * The two ai_usage guardrail queries are told apart the same way PostgREST sees
 * them: head:true is the request-window counter, the row select is the managed
 * token sum. todaySpy proves the cap query does (not) run.
 */
function stubClient(opts: {
  byokCredential?: boolean
  lastMinute?: { count: number | null; error?: unknown }
  today?: { rows?: UsageRow[]; count?: number; error?: unknown }
}) {
  const todaySpy = vi.fn()
  const client = {
    from: (table: string) => {
      if (table === 'ai_credentials') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.byokCredential ? { encrypted_key: 'enc' } : null,
              }),
            }),
          }),
        }
      }
      return {
        select: (_cols: string, sopts?: { head?: boolean }) => {
          let result: Record<string, unknown>
          if (sopts?.head) {
            result = { count: opts.lastMinute?.count ?? 0, error: opts.lastMinute?.error ?? null }
          } else {
            todaySpy()
            const rows = opts.today?.rows ?? []
            result = {
              data: rows,
              count: opts.today?.count ?? rows.length,
              error: opts.today?.error ?? null,
            }
          }
          const builder: { eq: () => unknown; gte: () => Promise<unknown> } = {
            eq: () => builder,
            gte: async () => result,
          }
          return builder
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, todaySpy }
}

async function runPing(client: SupabaseClient) {
  const { executeAiTask } = await import('./gateway')
  return executeAiTask(client, 'user-1', 'ping', { message: 'hello' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreate.mockResolvedValue(PROVIDER_OK)
})

afterEach(() => {
  delete process.env.AI_RATE_LIMIT_PER_MINUTE
  delete process.env.AI_MANAGED_DAILY_TOKEN_CAP
  vi.restoreAllMocks()
})

describe('sliding-window request limit', () => {
  test('under the limit the call goes through and is metered', async () => {
    const { client } = stubClient({
      lastMinute: { count: 9 },
      today: { rows: [{ input_tokens: 100, output_tokens: 50 }] },
    })
    const result = await runPing(client)
    expect(result).toEqual({ ok: true, data: { ok: true, echo: 'hello' } })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockRecordUsage).toHaveBeenCalledTimes(1)
  })

  test('at the limit the call is refused with 429 before any key work', async () => {
    const { client } = stubClient({ lastMinute: { count: 10 } })
    const result = await runPing(client)
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: expect.stringContaining('wait a minute'),
    })
    expect(mockResolveApiKey).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('BYOK is NOT exempt from the request limit', async () => {
    const { client } = stubClient({ byokCredential: true, lastMinute: { count: 10 } })
    const result = await runPing(client)
    expect(result).toMatchObject({ ok: false, status: 429 })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('AI_RATE_LIMIT_PER_MINUTE overrides the default of 10', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '3'
    const { client } = stubClient({ lastMinute: { count: 3 } })
    expect(await runPing(client)).toMatchObject({ ok: false, status: 429 })
  })

  test('a failed window lookup fails OPEN', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = stubClient({
      lastMinute: { count: null, error: { message: 'permission denied' } },
    })
    const result = await runPing(client)
    expect(result).toMatchObject({ ok: true })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe('managed-tier daily token cap', () => {
  test("over the cap, a managed call is refused and the message points to the veteran's own key", async () => {
    const { client } = stubClient({
      lastMinute: { count: 0 },
      today: { rows: [{ input_tokens: 1_900_000, output_tokens: 100_000 }] },
    })
    const result = await runPing(client)
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: expect.stringContaining('your own API key in AI settings'),
    })
    expect(mockResolveApiKey).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('BYOK calls are exempt — the cap query never even runs', async () => {
    const { client, todaySpy } = stubClient({
      byokCredential: true,
      lastMinute: { count: 0 },
      today: { rows: [{ input_tokens: 5_000_000, output_tokens: 0 }] },
    })
    const result = await runPing(client)
    expect(result).toMatchObject({ ok: true })
    expect(todaySpy).not.toHaveBeenCalled()
  })

  test('a ledger longer than one PostgREST page counts as over-cap', async () => {
    const { client } = stubClient({
      lastMinute: { count: 0 },
      today: { rows: [{ input_tokens: 10, output_tokens: 10 }], count: 1001 },
    })
    expect(await runPing(client)).toMatchObject({ ok: false, status: 429 })
  })

  test('AI_MANAGED_DAILY_TOKEN_CAP overrides the default of 2,000,000', async () => {
    process.env.AI_MANAGED_DAILY_TOKEN_CAP = '500'
    const { client } = stubClient({
      lastMinute: { count: 0 },
      today: { rows: [{ input_tokens: 400, output_tokens: 100 }] },
    })
    expect(await runPing(client)).toMatchObject({ ok: false, status: 429 })
  })

  test('a failed cap lookup fails OPEN', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = stubClient({
      lastMinute: { count: 0 },
      today: { rows: [], error: { message: 'permission denied' } },
    })
    const result = await runPing(client)
    expect(result).toMatchObject({ ok: true })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
