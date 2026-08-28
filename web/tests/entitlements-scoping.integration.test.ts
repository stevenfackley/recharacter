import { describe, it, expect, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode } from './helpers'
import { closeDb } from '@/db'
import { entitlements } from '@/db/schema'
import { saveEncryptedKey } from '@/lib/ai/credentials'
import {
  isEntitled,
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
