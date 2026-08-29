import { describe, it, expect, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode } from './helpers'
import { closeDb } from '@/db'
import { entitlements, pendingCheckouts } from '@/db/schema'
import { saveEncryptedKey } from '@/lib/ai/credentials'
import {
  isEntitled,
  hasPaidEntitlement,
  grantEntitlement,
  recordPendingCheckout,
  listPendingCheckouts,
  clearPendingCheckout,
} from '@/lib/billing'

afterAll(closeDb)

/** Session ids are globally unique in the table; derive them from the owner. */
const session = (owner: string, n = 1) => `cs_${n}_${owner}`

describe('the freemium gate', () => {
  it('is closed until the unlock is granted, and only for the buyer', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    expect(await isEntitled(alice)).toBe(false)
    expect(await grantEntitlement(alice, session(alice))).toBe('granted')
    expect(await isEntitled(alice)).toBe(true)
    expect(await isEntitled(bob)).toBe(false)
  })

  it('opens for a BYOK credential alone — no double-charging', async () => {
    const alice = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext')
    expect(await isEntitled(alice)).toBe(true)
  })
})

describe('hasPaidEntitlement', () => {
  it('is true only for the owner who actually paid', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    expect(await hasPaidEntitlement(alice)).toBe(false)
    await grantEntitlement(alice, session(alice))
    expect(await hasPaidEntitlement(alice)).toBe(true)
    expect(await hasPaidEntitlement(bob)).toBe(false)
  })

  it('stays false for a BYOK-only owner — a key unlocks, it does not pay', async () => {
    const alice = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext')
    expect(await isEntitled(alice)).toBe(true)
    expect(await hasPaidEntitlement(alice)).toBe(false)
  })
})

describe('grantEntitlement', () => {
  it('is idempotent: a second webhook for an entitled owner reports already_entitled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const alice = freshOwner()
    expect(await grantEntitlement(alice, session(alice, 1))).toBe('granted')
    expect(await grantEntitlement(alice, session(alice, 2))).toBe('already_entitled')
    expect(warn).toHaveBeenCalled()
    expect(await db().select().from(entitlements).where(eq(entitlements.ownerId, alice))).toHaveLength(1)
    warn.mockRestore()
  })

  it("refuses a checkout session already spent by another owner", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const shared = session(alice)
    expect(await grantEntitlement(alice, shared)).toBe('granted')
    // Replaying Alice's session for Bob must not silently entitle him.
    await expect(grantEntitlement(bob, shared)).rejects.toSatisfy((e) => pgCode(e) === '23505')
    expect(await isEntitled(bob)).toBe(false)
  })

  it("refuses another owner's session id even when the caller is already entitled", async () => {
    // Bob holds his own unlock, so the insert is stopped by the owner_id unique
    // and never reaches the stripe_session_id one — the 23505 the test above
    // relies on cannot fire. Without the explicit lookup this replay would be
    // logged as a harmless duplicate purchase and return already_entitled.
    const alice = freshOwner()
    const bob = freshOwner()
    expect(await grantEntitlement(alice, 'cs_a1_' + alice)).toBe('granted')
    expect(await grantEntitlement(bob, 'cs_b1_' + bob)).toBe('granted')
    await expect(grantEntitlement(bob, 'cs_a1_' + alice))
      .rejects.toThrow('stripe session belongs to another account')
    const bobRows = await db().select().from(entitlements).where(eq(entitlements.ownerId, bob))
    expect(bobRows).toHaveLength(1)
    expect(bobRows[0].stripeSessionId).toBe('cs_b1_' + bob)
  })

  it('clears the pending checkout it was granted for', async () => {
    const alice = freshOwner()
    const s = session(alice)
    await recordPendingCheckout(alice, s)
    expect(await grantEntitlement(alice, s)).toBe('granted')
    expect(await listPendingCheckouts(alice)).toEqual([])
  })
})

describe('entitlements are client-immutable', () => {
  it('refuses an UPDATE outright with 42501', async () => {
    const alice = freshOwner()
    await grantEntitlement(alice, session(alice))
    await expect(
      db().update(entitlements).set({ kind: 'case_unlock' }).where(eq(entitlements.ownerId, alice)),
    ).rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect(await isEntitled(alice)).toBe(true)
  })
})

describe('pending checkouts', () => {
  it('recordPendingCheckout writes one owner-scoped row carrying the session id', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const s = session(alice)
    await recordPendingCheckout(alice, s)
    const rows = await db().select().from(pendingCheckouts).where(eq(pendingCheckouts.ownerId, alice))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ownerId: alice, stripeSessionId: s })
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].createdAt).toBeInstanceOf(Date)
    // Nothing else rides along: the row is the session id, who started it, and when.
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'ownerId', 'stripeSessionId'])
    expect(await listPendingCheckouts(bob)).toEqual([])
  })

  it('recording the same session twice for the same owner is refused with 23505, not duplicated', async () => {
    // Plain insert, no on-conflict clause: the unique on stripe_session_id is
    // what answers a double-submitted checkout, and it answers with an error
    // rather than a second row.
    const alice = freshOwner()
    const s = session(alice)
    await recordPendingCheckout(alice, s)
    await expect(recordPendingCheckout(alice, s)).rejects.toSatisfy((e) => pgCode(e) === '23505')
    expect(await listPendingCheckouts(alice)).toEqual([s])
  })

  it('are listed only for the owner who started them', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    await recordPendingCheckout(alice, session(alice))
    expect(await listPendingCheckouts(alice)).toEqual([session(alice)])
    expect(await listPendingCheckouts(bob)).toEqual([])
  })

  it("another owner's clear does not remove Alice's pending row", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const s = session(alice)
    await recordPendingCheckout(alice, s)
    await clearPendingCheckout(bob, s)
    expect(await listPendingCheckouts(alice)).toEqual([s])
    await clearPendingCheckout(alice, s)
    expect(await listPendingCheckouts(alice)).toEqual([])
  })
})
