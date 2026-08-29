import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode, allowLedgerDelete } from './helpers'
import { closeDb, getDb } from '@/db'
import { aiAttempts, aiCredentials, aiUsage } from '@/db/schema'
import { resetEnvForTests } from '@/lib/env'
import {
  getEncryptedKey,
  saveEncryptedKey,
  deleteEncryptedKey,
  credentialCreatedAt,
} from '@/lib/ai/credentials'
import { encryptSecret, decryptSecret } from '@/lib/ai/crypto'
import { recordAttempt, recordUsage, usageTotals } from '@/lib/ai/usage'
import { checkAiLimits, MANAGED_DAILY_CALL_CEILING } from '@/lib/ai/limits'

// `getDb` becomes a passthrough vi.fn so one test at a time can make a chosen
// call throw and prove the guardrails fail OPEN. Every other caller in this
// file — helpers.ts included — goes through the same wrapper to the real client.
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, getDb: vi.fn(actual.getDb) }
})
const realGetDb = vi.mocked(getDb).getMockImplementation()!

/** From now on, the Nth `getDb()` call throws; every other call is real. */
function failGetDbOnCall(n: number) {
  let calls = 0
  vi.mocked(getDb).mockImplementation(() => {
    calls += 1
    if (calls === n) throw new Error(`simulated database outage on getDb() call ${n}`)
    return realGetDb()
  })
}

afterAll(closeDb)

afterEach(() => {
  delete process.env.AI_RATE_LIMIT_PER_MINUTE
  delete process.env.AI_MANAGED_DAILY_TOKEN_CAP
  delete process.env.AI_GLOBAL_DAILY_TOKEN_CAP
  resetEnvForTests()
  vi.mocked(getDb).mockImplementation(realGetDb)
  vi.restoreAllMocks()
})

const managedRow = (ownerId: string, tokens: number, createdAt?: Date) => ({
  ownerId, task: 'ping', model: 'claude-opus-4-8', byok: false,
  inputTokens: tokens, outputTokens: 0, ...(createdAt ? { createdAt } : {}),
})

const KEK = Buffer.alloc(32).toString('base64')

describe('BYOK credentials', () => {
  it('round-trips a ciphertext for its owner', async () => {
    const alice = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext-a')
    expect(await getEncryptedKey(alice)).toBe('ciphertext-a')
  })

  it("another owner cannot read Alice's credential", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext-a')
    expect(await getEncryptedKey(bob)).toBeNull()
  })

  it('saving again replaces the ciphertext in place', async () => {
    const alice = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext-a')
    await saveEncryptedKey(alice, 'ciphertext-b')
    expect(await getEncryptedKey(alice)).toBe('ciphertext-b')
  })

  it('reports when the credential was created, and null when there is none', async () => {
    const alice = freshOwner()
    expect(await credentialCreatedAt(alice)).toBeNull()
    await saveEncryptedKey(alice, 'ciphertext-a')
    expect(await credentialCreatedAt(alice)).toBeInstanceOf(Date)
  })

  it("deleting removes only the asking owner's credential", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext-a')
    await saveEncryptedKey(bob, 'ciphertext-b')
    await deleteEncryptedKey(alice)
    expect(await getEncryptedKey(alice)).toBeNull()
    expect(await getEncryptedKey(bob)).toBe('ciphertext-b')
  })

  it('re-saving bumps updated_at and leaves created_at alone', async () => {
    const alice = freshOwner()
    await saveEncryptedKey(alice, 'ciphertext-a')
    const [before] = await db().select().from(aiCredentials).where(eq(aiCredentials.ownerId, alice))
    await new Promise((r) => setTimeout(r, 20))
    await saveEncryptedKey(alice, 'ciphertext-b')
    const [after] = await db().select().from(aiCredentials).where(eq(aiCredentials.ownerId, alice))
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
  })

  it('deleting for an owner with no credential is a no-op, not an error', async () => {
    await expect(deleteEncryptedKey(freshOwner())).resolves.toBeUndefined()
  })
})

describe('ciphertext is bound to its owner', () => {
  it("a key encrypted for Alice cannot be decrypted as Bob's", () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const ciphertext = encryptSecret('sk-ant-alice', KEK, alice)
    expect(decryptSecret(ciphertext, KEK, alice)).toBe('sk-ant-alice')
    // The AAD check specifically — not a length or parse failure that would also
    // satisfy a bare toThrow().
    expect(() => decryptSecret(ciphertext, KEK, bob)).toThrow(/unable to authenticate data/i)
  })
})

describe('usage ledger', () => {
  const usage = { task: 'ping', model: 'claude-opus-4-8', byok: false, inputTokens: 11, outputTokens: 7 }

  it("totals count only the asking owner's rows", async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    await recordUsage(alice, usage)
    await recordUsage(alice, { ...usage, inputTokens: 1, outputTokens: 2 })
    expect(await usageTotals(alice)).toEqual({ inputTokens: 12, outputTokens: 9, calls: 2 })
    expect(await usageTotals(bob)).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 })
  })

  it('totals count BYOK and managed rows alike', async () => {
    const alice = freshOwner()
    await recordUsage(alice, { ...usage, byok: true, inputTokens: 10, outputTokens: 1 })
    await recordUsage(alice, { ...usage, byok: false, inputTokens: 5, outputTokens: 2 })
    expect(await usageTotals(alice)).toEqual({ inputTokens: 15, outputTokens: 3, calls: 2 })
  })

  it('recordUsage writes every column of a BYOK row', async () => {
    const alice = freshOwner()
    await recordUsage(alice, {
      task: 'draft', model: 'claude-opus-4-8', byok: true, inputTokens: 123, outputTokens: 45,
    })
    const rows = await db().select().from(aiUsage).where(eq(aiUsage.ownerId, alice))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ownerId: alice, task: 'draft', model: 'claude-opus-4-8', byok: true, inputTokens: 123, outputTokens: 45,
    })
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].createdAt).toBeInstanceOf(Date)
  })

  it('recordAttempt fails CLOSED on a bad insert; recordUsage with the same input fails open', async () => {
    // The docblock contract: an attempt that could not be counted must not let
    // the model run, while a usage row that could not be written must not eat
    // an answer the veteran already has. Same bad owner id, opposite outcomes.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAttempt('not-a-uuid', 'ping')).rejects.toSatisfy((e) => pgCode(e) === '22P02')
    await expect(recordUsage('not-a-uuid', usage)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('ai_usage insert failed', expect.anything())
  })
})

describe('AI cost guardrails', () => {
  const usage = { task: 'ping', model: 'claude-opus-4-8', byok: false, inputTokens: 1, outputTokens: 1 }

  /**
   * The shared managed ledger is append-only and never reset between runs, so a
   * long-lived database eventually holds enough tokens for the day to trip the
   * GLOBAL ceiling on its own and turn every `{ allowed: true }` expectation
   * below into a flake. Tests that assert a call is allowed give the global cap
   * headroom no test fixture can reach.
   */
  const withGlobalHeadroom = () => {
    process.env.AI_GLOBAL_DAILY_TOKEN_CAP = '999999999999'
    resetEnvForTests()
  }

  it('allows a call under the per-minute limit', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    withGlobalHeadroom()
    const alice = freshOwner()
    await recordAttempt(alice, 'ping')
    expect(await checkAiLimits(alice, false)).toEqual({ allowed: true })
  })

  it('refuses at the per-minute limit, and only for the owner who hit it', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    withGlobalHeadroom()
    const alice = freshOwner()
    const bob = freshOwner()
    await recordAttempt(alice, 'ping')
    await recordAttempt(alice, 'ping')
    expect(await checkAiLimits(alice, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('wait a minute'),
    })
    expect(await checkAiLimits(bob, false)).toEqual({ allowed: true })
  })

  it('counts ATTEMPTS, not completed calls', async () => {
    // The whole point of the ai_attempts table: usage rows are written after the
    // provider answers, so a caller whose calls all fail — or who fires them
    // concurrently — would never accumulate any and would never be limited.
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    withGlobalHeadroom()
    const alice = freshOwner()
    await recordUsage(alice, usage)
    await recordUsage(alice, usage)
    await recordUsage(alice, usage)
    expect(await checkAiLimits(alice, false)).toEqual({ allowed: true })
    await recordAttempt(alice, 'ping')
    await recordAttempt(alice, 'ping')
    expect(await checkAiLimits(alice, false)).toMatchObject({ allowed: false })
  })

  it('does not exempt BYOK from the per-minute limit', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    resetEnvForTests()
    const alice = freshOwner()
    await recordAttempt(alice, 'ping')
    await recordAttempt(alice, 'ping')
    expect(await checkAiLimits(alice, true)).toMatchObject({ allowed: false })
  })

  it("refuses over the per-user managed daily cap and points at the veteran's own key", async () => {
    process.env.AI_MANAGED_DAILY_TOKEN_CAP = '10'
    resetEnvForTests()
    const alice = freshOwner()
    await recordUsage(alice, { ...usage, inputTokens: 6, outputTokens: 5 })
    expect(await checkAiLimits(alice, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('your own API key in AI settings'),
    })
  })

  it('refuses at the managed daily CALL ceiling even when every call was tiny', async () => {
    // The shape a pure token cap is slowest to catch: a thousand zero-token
    // calls spend nothing measurable and still cost a thousand round trips.
    withGlobalHeadroom()
    const alice = freshOwner()
    await db().insert(aiUsage).values(
      Array.from({ length: MANAGED_DAILY_CALL_CEILING }, () => ({
        ownerId: alice, task: 'ping', model: 'claude-opus-4-8',
        byok: false, inputTokens: 0, outputTokens: 0,
      })),
    )
    expect(await checkAiLimits(alice, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('your own API key in AI settings'),
    })
  }, 30_000)

  it('exempts BYOK from the per-user managed daily cap', async () => {
    process.env.AI_MANAGED_DAILY_TOKEN_CAP = '10'
    withGlobalHeadroom()
    const alice = freshOwner()
    await recordUsage(alice, { ...usage, inputTokens: 6, outputTokens: 5 })
    expect(await checkAiLimits(alice, true)).toEqual({ allowed: true })
  })

  it('refuses a managed call once the SHARED daily ceiling is spent, whoever spent it', async () => {
    process.env.AI_GLOBAL_DAILY_TOKEN_CAP = '1'
    resetEnvForTests()
    const alice = freshOwner()
    const bob = freshOwner()
    await recordUsage(alice, usage)
    // Bob has spent nothing himself; the shared managed pool is what is exhausted.
    expect(await checkAiLimits(bob, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('shared AI capacity'),
    })
  })

  it('exempts BYOK from the shared daily ceiling', async () => {
    process.env.AI_GLOBAL_DAILY_TOKEN_CAP = '1'
    resetEnvForTests()
    const alice = freshOwner()
    const bob = freshOwner()
    await recordUsage(alice, usage)
    expect(await checkAiLimits(bob, true)).toEqual({ allowed: true })
  })

  it('a usage row that cannot be written never fails the request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const alice = freshOwner()
    // input_tokens is int4; 2^40 overflows it, so the insert raises 22003.
    await expect(
      recordUsage(alice, { ...usage, inputTokens: 2 ** 40 }),
    ).resolves.toBeUndefined()
    expect(await db().select().from(aiUsage).where(eq(aiUsage.ownerId, alice))).toEqual([])
    vi.restoreAllMocks()
  })

  it('the managed day starts at midnight UTC: 23:59:59Z yesterday is not counted, 00:00:00Z today is', async () => {
    process.env.AI_MANAGED_DAILY_TOKEN_CAP = '10'
    withGlobalHeadroom()
    const alice = freshOwner()
    const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
    const lastSecondOfYesterday = new Date(todayStart.getTime() - 1_000)
    await db().insert(aiUsage).values(managedRow(alice, 100, lastSecondOfYesterday))
    expect(await checkAiLimits(alice, false)).toEqual({ allowed: true })
    await db().insert(aiUsage).values(managedRow(alice, 100, todayStart))
    expect(await checkAiLimits(alice, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('resets at midnight UTC'),
    })
  })

  it('the per-minute window slides: an attempt 61 s old is outside it, one 59 s old is inside', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '1'
    withGlobalHeadroom()
    const alice = freshOwner()
    await db().insert(aiAttempts).values({ ownerId: alice, task: 'ping', createdAt: new Date(Date.now() - 61_000) })
    expect(await checkAiLimits(alice, true)).toEqual({ allowed: true })
    await db().insert(aiAttempts).values({ ownerId: alice, task: 'ping', createdAt: new Date(Date.now() - 59_000) })
    expect(await checkAiLimits(alice, true)).toEqual({
      allowed: false,
      error: expect.stringContaining('wait a minute'),
    })
  })

  it('sums a day past 2^31 tokens without int4 overflow: the caps fire instead of failing open', async () => {
    // input_tokens is int4, so each row fits and only the SUM crosses 2^31. A
    // `::int` on the aggregate would raise 22003 here, land in the catch, and
    // let the busiest day through unmetered — which is exactly what the
    // `::bigint` in limits.ts exists to prevent.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const alice = freshOwner()
    const bob = freshOwner()
    await db().insert(aiUsage).values([managedRow(alice, 2_000_000_000), managedRow(alice, 2_000_000_000)])
    try {
      // Default caps (2M personal, 20M shared) — 4e9 is past both.
      expect(await checkAiLimits(alice, false)).toEqual({
        allowed: false,
        error: expect.stringContaining('your own API key in AI settings'),
      })
      expect(await checkAiLimits(bob, false)).toEqual({
        allowed: false,
        error: expect.stringContaining('shared AI capacity'),
      })
      expect(error).not.toHaveBeenCalled()
    } finally {
      // The one deliberate cleanup in this file. These rows sit in the SHARED
      // managed aggregate for the rest of the UTC day, and the ledger is
      // append-only, so left behind they accumulate 4e9 per run against the
      // ~1e12 of headroom every `allowed: true` assertion above relies on.
      await allowLedgerDelete((tx) => tx.delete(aiUsage).where(eq(aiUsage.ownerId, alice)))
    }
  })

  describe('every lookup fails OPEN', () => {
    // Each case first proves the same call is REFUSED with the database
    // healthy, so the `allowed: true` that follows is the outage talking and
    // not an owner who was simply under the limit.
    it('when the rate-limit lookup throws', async () => {
      process.env.AI_RATE_LIMIT_PER_MINUTE = '1'
      withGlobalHeadroom()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const alice = freshOwner()
      await recordAttempt(alice, 'ping')
      expect(await checkAiLimits(alice, true)).toMatchObject({ allowed: false })
      failGetDbOnCall(1)
      expect(await checkAiLimits(alice, true)).toEqual({ allowed: true })
      expect(error).toHaveBeenCalledWith('ai rate-limit lookup failed', expect.any(Error))
    })

    it('when the per-user managed-cap lookup throws', async () => {
      process.env.AI_MANAGED_DAILY_TOKEN_CAP = '10'
      withGlobalHeadroom()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const alice = freshOwner()
      await recordUsage(alice, { ...usage, inputTokens: 6, outputTokens: 5 })
      expect(await checkAiLimits(alice, false)).toMatchObject({ allowed: false })
      failGetDbOnCall(2)
      expect(await checkAiLimits(alice, false)).toEqual({ allowed: true })
      expect(error).toHaveBeenCalledWith('ai managed-cap lookup failed', expect.any(Error))
    })

    it('when the shared-cap lookup throws', async () => {
      process.env.AI_GLOBAL_DAILY_TOKEN_CAP = '1'
      resetEnvForTests()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const alice = freshOwner()
      const bob = freshOwner()
      await recordUsage(alice, usage)
      expect(await checkAiLimits(bob, false)).toMatchObject({ allowed: false })
      failGetDbOnCall(3)
      expect(await checkAiLimits(bob, false)).toEqual({ allowed: true })
      expect(error).toHaveBeenCalledWith('ai global-cap lookup failed', expect.any(Error))
    })
  })
})
