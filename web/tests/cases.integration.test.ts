import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner } from './helpers'
import { closeDb } from '@/db'
import { cases } from '@/db/schema'
import { getOrCreateCase, assertCaseOwned, CaseNotFoundError } from '@/lib/cases'

/**
 * Owner scoping for the case root. RLS used to guarantee this in the database;
 * now it is `eq(cases.ownerId, ownerId)` on every statement, and these are the
 * tests that prove it.
 */
afterAll(closeDb)

describe('getOrCreateCase', () => {
  it('is idempotent: two calls yield the same case and exactly one row', async () => {
    const alice = freshOwner()
    const first = await getOrCreateCase(alice)
    const second = await getOrCreateCase(alice)
    expect(second.id).toBe(first.id)
    expect(await db().select().from(cases).where(eq(cases.ownerId, alice))).toHaveLength(1)
  })

  it('gives a different owner a different case', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const aliceCase = await getOrCreateCase(alice)
    const bobCase = await getOrCreateCase(bob)
    expect(bobCase.id).not.toBe(aliceCase.id)
  })

  it('survives a genuine race: eight concurrent calls create one row and all return its id', async () => {
    // The pool is four connections wide, so these interleave for real: several
    // inserts reach Postgres before any of them has committed. `on conflict do
    // nothing` plus the re-select is the whole race handling — no 23505 may
    // escape, and nobody may be handed a second case.
    const alice = freshOwner()
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateCase(alice)))
    expect(new Set(results.map((r) => r.id)).size).toBe(1)
    expect(await db().select().from(cases).where(eq(cases.ownerId, alice))).toHaveLength(1)
  })
})

describe('assertCaseOwned', () => {
  it('resolves for the owner of the case', async () => {
    const alice = freshOwner()
    const aliceCase = await getOrCreateCase(alice)
    await expect(assertCaseOwned(alice, aliceCase.id)).resolves.toBeUndefined()
  })

  it("rejects for a stranger holding another owner's case id", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const aliceCase = await getOrCreateCase(alice)
    await expect(assertCaseOwned(bob, aliceCase.id)).rejects.toBeInstanceOf(CaseNotFoundError)
  })

  it('rejects for a case id that does not exist at all', async () => {
    const alice = freshOwner()
    await expect(assertCaseOwned(alice, freshOwner())).rejects.toBeInstanceOf(CaseNotFoundError)
  })

  it('does not disclose whether a case exists: "not yours" and "not real" reject word for word alike', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const aliceCase = await getOrCreateCase(alice)
    const capture = (p: Promise<void>) => p.then(() => null, (err: unknown) => err as Error)
    const notMine = await capture(assertCaseOwned(bob, aliceCase.id))
    const notReal = await capture(assertCaseOwned(bob, freshOwner()))
    expect(notMine).toBeInstanceOf(CaseNotFoundError)
    expect(notReal).toBeInstanceOf(CaseNotFoundError)
    expect(notMine!.message).toBe(notReal!.message)
    expect(notMine!.name).toBe(notReal!.name)
    expect(notMine!.message).not.toContain(aliceCase.id)
  })
})
