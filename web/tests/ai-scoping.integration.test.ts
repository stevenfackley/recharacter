import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner } from './helpers'
import { closeDb } from '@/db'
import { aiUsage } from '@/db/schema'
import { resetEnvForTests } from '@/lib/env'
import {
  getEncryptedKey,
  saveEncryptedKey,
  deleteEncryptedKey,
  credentialCreatedAt,
} from '@/lib/ai/credentials'
import { encryptSecret, decryptSecret } from '@/lib/ai/crypto'
import { recordUsage, usageTotals } from '@/lib/ai/usage'
import { checkAiLimits } from '@/lib/ai/limits'

afterAll(closeDb)

afterEach(() => {
  delete process.env.AI_RATE_LIMIT_PER_MINUTE
  delete process.env.AI_MANAGED_DAILY_TOKEN_CAP
  delete process.env.AI_GLOBAL_DAILY_TOKEN_CAP
  resetEnvForTests()
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
})

describe('ciphertext is bound to its owner', () => {
  it("a key encrypted for Alice cannot be decrypted as Bob's", () => {
    const alice = freshOwner()
    const bob = freshOwner()
    const ciphertext = encryptSecret('sk-ant-alice', KEK, alice)
    expect(decryptSecret(ciphertext, KEK, alice)).toBe('sk-ant-alice')
    expect(() => decryptSecret(ciphertext, KEK, bob)).toThrow()
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
})

describe('AI cost guardrails', () => {
  const usage = { task: 'ping', model: 'claude-opus-4-8', byok: false, inputTokens: 1, outputTokens: 1 }

  it('allows a call under the per-minute limit', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    resetEnvForTests()
    const alice = freshOwner()
    await recordUsage(alice, usage)
    expect(await checkAiLimits(alice, false)).toEqual({ allowed: true })
  })

  it('refuses at the per-minute limit, and only for the owner who hit it', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    resetEnvForTests()
    const alice = freshOwner()
    const bob = freshOwner()
    await recordUsage(alice, usage)
    await recordUsage(alice, usage)
    expect(await checkAiLimits(alice, false)).toEqual({
      allowed: false,
      error: expect.stringContaining('wait a minute'),
    })
    expect(await checkAiLimits(bob, false)).toEqual({ allowed: true })
  })

  it('does not exempt BYOK from the per-minute limit', async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '2'
    resetEnvForTests()
    const alice = freshOwner()
    await recordUsage(alice, { ...usage, byok: true })
    await recordUsage(alice, { ...usage, byok: true })
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

  it('exempts BYOK from the per-user managed daily cap', async () => {
    process.env.AI_MANAGED_DAILY_TOKEN_CAP = '10'
    resetEnvForTests()
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
})
