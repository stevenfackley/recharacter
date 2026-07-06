import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

import { isEntitled, recordPendingCheckout, grantEntitlement } from '@/lib/billing'

/** Fakes the two `.from(table).select().eq().maybeSingle()` calls isEntitled makes. */
function fakeSupabase(rows: { entitlements?: unknown; ai_credentials?: unknown }): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: rows[table as keyof typeof rows] ?? null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('isEntitled', () => {
  test('entitled via a paid unlock alone', async () => {
    const supabase = fakeSupabase({ entitlements: { id: 'ent-1' }, ai_credentials: null })
    expect(await isEntitled(supabase, 'user-1')).toBe(true)
  })

  test('entitled via a BYOK credential alone', async () => {
    const supabase = fakeSupabase({ entitlements: null, ai_credentials: { owner_id: 'user-1' } })
    expect(await isEntitled(supabase, 'user-1')).toBe(true)
  })

  test('not entitled when neither exists', async () => {
    const supabase = fakeSupabase({ entitlements: null, ai_credentials: null })
    expect(await isEntitled(supabase, 'user-1')).toBe(false)
  })
})

describe('recordPendingCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  test('inserts a pending_checkouts row for the signed-in user', async () => {
    const mockInsert = vi.fn(async () => ({ error: null }))
    mockFrom.mockImplementation(() => ({ insert: mockInsert }))

    await recordPendingCheckout('cs_test_123')

    expect(mockFrom).toHaveBeenCalledWith('pending_checkouts')
    expect(mockInsert).toHaveBeenCalledWith({ owner_id: 'user-1', stripe_session_id: 'cs_test_123' })
  })

  test('throws when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    await expect(recordPendingCheckout('cs_test_123')).rejects.toThrow('Not authenticated')
  })
})

describe('grantEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  test('inserts the entitlement and clears the pending checkout', async () => {
    const mockInsert = vi.fn(async () => ({ error: null }))
    const mockEq = vi.fn(async () => ({ error: null }))
    const mockDelete = vi.fn(() => ({ eq: mockEq }))
    mockFrom.mockImplementation((table: string) =>
      (table === 'entitlements' ? { insert: mockInsert } : { delete: mockDelete }))

    await grantEntitlement('cs_test_123')

    expect(mockInsert).toHaveBeenCalledWith({
      owner_id: 'user-1', kind: 'case_unlock', stripe_session_id: 'cs_test_123',
    })
    expect(mockDelete).toHaveBeenCalled()
    expect(mockEq).toHaveBeenCalledWith('stripe_session_id', 'cs_test_123')
  })

  test('swallows a 23505 duplicate (already recorded) and still clears the pending row', async () => {
    const mockEq = vi.fn(async () => ({ error: null }))
    mockFrom.mockImplementation((table: string) =>
      (table === 'entitlements'
        ? { insert: async () => ({ error: { code: '23505' } }) }
        : { delete: () => ({ eq: mockEq }) }))

    await expect(grantEntitlement('cs_test_123')).resolves.toBeUndefined()
    expect(mockEq).toHaveBeenCalled()
  })

  test('rethrows a non-23505 insert error', async () => {
    mockFrom.mockImplementation((table: string) =>
      (table === 'entitlements'
        ? { insert: async () => ({ error: { code: '500', message: 'db down' } }) }
        : { delete: () => ({ eq: async () => ({ error: null }) }) }))

    await expect(grantEntitlement('cs_test_123')).rejects.toBeTruthy()
  })

  test('throws when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    await expect(grantEntitlement('cs_test_123')).rejects.toThrow('Not authenticated')
  })
})
