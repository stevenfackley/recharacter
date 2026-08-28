import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Db } from '@/db'

/**
 * The freemium gate's real behaviour — grant, idempotent re-grant, cross-owner
 * session replay, isolation — is proven against Postgres in
 * tests/entitlements-scoping.integration.test.ts.
 *
 * What is left here is the one branch a live database will not reproduce on
 * demand: the insert reported no new entitlement AND the owner has none. That
 * combination means the write was rejected for a reason other than the
 * one-per-owner conflict, and it must never be swallowed — silently returning
 * 'already_entitled' there would tell Stripe the unlock was delivered when the
 * veteran did not get it.
 */

const deleted = vi.fn()
let insertReturning: Array<Record<string, unknown>> = []
let existingEntitlement: Array<{ stripeSessionId: string }> = []

const fakeDb = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: async () => insertReturning }),
    }),
  }),
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => existingEntitlement }) }),
  }),
  delete: () => ({ where: async () => deleted() }),
} as unknown as Db

vi.mock('@/db', () => ({ getDb: () => fakeDb }))

import { grantEntitlement } from '@/lib/billing'

beforeEach(() => {
  vi.clearAllMocks()
  insertReturning = []
  existingEntitlement = []
})

describe('grantEntitlement', () => {
  test('reports already_entitled when the owner already holds the unlock', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    existingEntitlement = [{ stripeSessionId: 'cs_first' }]

    await expect(grantEntitlement('owner-1', 'cs_second')).resolves.toBe('already_entitled')
    expect(warn).toHaveBeenCalledWith('entitlement already held', {
      ownerId: 'owner-1',
      existing: 'cs_first',
      incoming: 'cs_second',
    })
    expect(deleted).toHaveBeenCalledTimes(1) // the pending row is still cleared
  })

  test('reports granted and clears the pending checkout when the row is created', async () => {
    insertReturning = [{ id: 'ent-1' }]
    await expect(grantEntitlement('owner-1', 'cs_new')).resolves.toBe('granted')
    expect(deleted).toHaveBeenCalledTimes(1)
  })

  test('throws when nothing was inserted and the owner has no entitlement', async () => {
    await expect(grantEntitlement('owner-1', 'cs_new')).rejects.toThrow(/cs_new/)
    expect(deleted).not.toHaveBeenCalled()
  })
})
