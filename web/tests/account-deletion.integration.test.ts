// @vitest-environment node
//
// The legal-posture promise (docs/legal-posture.md, "Data sensitivity"), proven
// end to end against real Postgres, a real object store and a stubbed Keycloak
// admin: the export shows the veteran everything we hold about them and leaks no
// ciphertext, and one click removes every row in all TEN owner-scoped tables —
// including the append-only ai_usage/entitlements ledgers the app role otherwise
// cannot touch — plus every stored object, while another veteran's identical
// data is untouched.
//
// Two orderings carry the whole guarantee and are asserted directly:
//   - identity credentials are proven BEFORE anything is deleted, so a broken
//     admin client leaves the account whole rather than half-erased;
//   - the ledger guard is back in force the moment our transaction commits.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode } from './helpers'
import { closeDb } from '@/db'
import {
  cases, serviceFacts, caseContext, evidenceItems, nexusAnswers,
  drafts, aiUsage, aiCredentials, entitlements, pendingCheckouts,
} from '@/db/schema'
import { MemoryObjectStore } from '@/lib/storage/object-store'
import { listOwnerDocuments, putCaseDocument } from '@/lib/case-documents'
import { collectExport, deleteAccountData, DeletionUnavailableError } from '@/lib/account'
import { resetEnvForTests } from '@/lib/env'
import type { KeycloakAdmin } from '@/lib/keycloak-admin'

// Real magic bytes: putCaseDocument sniffs the content type and rejects anything else.
const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%seeded discharge packet\n')

/** Every table an owner has rows in, keyed by its real Postgres name. */
async function counts(ownerId: string): Promise<Record<string, number>> {
  const len = (rows: unknown[]) => rows.length
  return {
    cases: len(await db().select({ id: cases.id }).from(cases).where(eq(cases.ownerId, ownerId))),
    service_facts: len(await db().select({ id: serviceFacts.id }).from(serviceFacts).where(eq(serviceFacts.ownerId, ownerId))),
    case_context: len(await db().select({ id: caseContext.id }).from(caseContext).where(eq(caseContext.ownerId, ownerId))),
    evidence_items: len(await db().select({ id: evidenceItems.id }).from(evidenceItems).where(eq(evidenceItems.ownerId, ownerId))),
    nexus_answers: len(await db().select({ id: nexusAnswers.id }).from(nexusAnswers).where(eq(nexusAnswers.ownerId, ownerId))),
    drafts: len(await db().select({ id: drafts.id }).from(drafts).where(eq(drafts.ownerId, ownerId))),
    ai_usage: len(await db().select({ id: aiUsage.id }).from(aiUsage).where(eq(aiUsage.ownerId, ownerId))),
    ai_credentials: len(await db().select({ id: aiCredentials.ownerId }).from(aiCredentials).where(eq(aiCredentials.ownerId, ownerId))),
    entitlements: len(await db().select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.ownerId, ownerId))),
    pending_checkouts: len(await db().select({ id: pendingCheckouts.id }).from(pendingCheckouts).where(eq(pendingCheckouts.ownerId, ownerId))),
  }
}

const ALL_TABLES = [
  'cases', 'service_facts', 'case_context', 'evidence_items', 'nexus_answers',
  'drafts', 'ai_usage', 'ai_credentials', 'entitlements', 'pending_checkouts',
] as const

const everyTable = (n: number) => Object.fromEntries(ALL_TABLES.map((t) => [t, n]))

/** One row in every owner-scoped table plus one stored document. */
async function seed(ownerId: string, store: MemoryObjectStore) {
  const [c] = await db().insert(cases).values({ ownerId }).returning({ id: cases.id })
  const caseId = c.id
  await db().insert(serviceFacts).values({
    caseId, ownerId, branch: 'Army', dischargeDate: '2015-04-01',
    characterization: 'OtherThanHonorable',
  })
  await db().insert(caseContext).values({ caseId, ownerId, conditionCategory: 'ptsd' })
  await db().insert(evidenceItems).values({ caseId, ownerId, itemType: 'dd214', status: 'collected' })
  await db().insert(nexusAnswers).values({ caseId, ownerId, q1Condition: 'seeded answer' })
  await db().insert(drafts).values({ caseId, ownerId, kind: 'personal_statement', content: 'seeded draft' })
  await db().insert(aiUsage).values({ ownerId, task: 'ping', model: 'test', inputTokens: 1, outputTokens: 1 })
  await db().insert(aiCredentials).values({ ownerId, encryptedKey: `SECRET_CIPHERTEXT_${ownerId}` })
  await db().insert(entitlements).values({ ownerId, kind: 'case_unlock', stripeSessionId: `cs_ent_${ownerId}` })
  await db().insert(pendingCheckouts).values({ ownerId, stripeSessionId: `cs_pend_${ownerId}` })
  const { key } = await putCaseDocument(store, ownerId, caseId, 'dd214.pdf', pdfBytes)
  return { caseId, key }
}

type StubAdmin = KeycloakAdmin & {
  getToken: ReturnType<typeof vi.fn>
  deleteUser: ReturnType<typeof vi.fn>
}

function stubAdmin(): StubAdmin {
  return { getToken: vi.fn(async () => 'tok'), deleteUser: vi.fn(async () => {}) }
}

const store = new MemoryObjectStore()
const alice = freshOwner()
const bob = freshOwner()
let bobKey: string

beforeAll(async () => {
  await seed(alice, store)
  bobKey = (await seed(bob, store)).key
}, 30_000)

afterAll(closeDb)

describe('collectExport', () => {
  it('hands the veteran every table we hold, and never the BYOK ciphertext', async () => {
    const exported = await collectExport(alice, store)

    expect(exported.ownerId).toBe(alice)
    expect(Date.parse(exported.exportedAt)).not.toBeNaN()
    expect(exported.case).toMatchObject({ owner_id: alice })
    expect(exported.serviceFacts).toMatchObject({ branch: 'Army', characterization: 'OtherThanHonorable' })
    expect(exported.caseContext).toMatchObject({ condition_category: 'ptsd' })
    expect(exported.evidenceItems).toHaveLength(1)
    expect(exported.evidenceItems[0]).toMatchObject({ item_type: 'dd214' })
    expect(exported.nexusAnswers).toMatchObject({ q1_condition: 'seeded answer' })
    expect(exported.drafts).toHaveLength(1)
    expect(exported.drafts[0]).toMatchObject({ kind: 'personal_statement', content: 'seeded draft' })
    expect(exported.aiUsage).toHaveLength(1)
    expect(exported.entitlements).toEqual([{ kind: 'case_unlock', created_at: expect.any(String) }])
    expect(exported.pendingCheckouts).toEqual([
      { stripe_session_id: `cs_pend_${alice}`, created_at: expect.any(String) },
    ])
    expect(exported.aiCredentials.present).toBe(true)
    expect(exported.aiCredentials.created_at).toEqual(expect.any(String))
    expect(exported.uploadedDocuments).toHaveLength(1)
    expect(exported.uploadedDocuments[0].startsWith(`${alice}/`)).toBe(true)

    const json = JSON.stringify(exported)
    expect(json).not.toContain('SECRET_CIPHERTEXT')
    expect(json).not.toContain('encrypted_key')
    // Dates are ISO strings in the document, not Date objects serialized by luck.
    expect(typeof (exported.case as Record<string, unknown>).created_at).toBe('string')
  })

  it('scopes strictly to the owner: Bob is absent from Alice\'s export', async () => {
    const exported = await collectExport(alice, store)
    const json = JSON.stringify(exported)
    expect(json).not.toContain(bob)
    expect(exported.uploadedDocuments).not.toContain(bobKey)
  })

  it('an account with nothing in it exports empty sections', async () => {
    const exported = await collectExport(freshOwner(), store)
    expect(exported.case).toBeNull()
    expect(exported.serviceFacts).toBeNull()
    expect(exported.evidenceItems).toEqual([])
    expect(exported.entitlements).toEqual([])
    expect(exported.pendingCheckouts).toEqual([])
    expect(exported.aiCredentials).toEqual({ present: false, created_at: null })
    expect(exported.uploadedDocuments).toEqual([])
  })
})

describe('deleteAccountData fails closed', () => {
  it('leaves everything when the identity provider rejects our credentials', async () => {
    const carol = freshOwner()
    await seed(carol, store)
    const admin = stubAdmin()
    admin.getToken.mockRejectedValue(new Error('keycloak token endpoint returned 401'))

    await expect(deleteAccountData(carol, { store, admin })).rejects.toThrow('401')

    expect(await counts(carol)).toEqual(everyTable(1))
    expect(await listOwnerDocuments(store, carol)).toHaveLength(1)
    expect(admin.deleteUser).not.toHaveBeenCalled()
  })

  it('refuses to start when the admin service account is unconfigured', async () => {
    const dave = freshOwner()
    await seed(dave, store)
    const previous = process.env.QAVREN_ADMIN_CLIENT_SECRET
    delete process.env.QAVREN_ADMIN_CLIENT_SECRET
    resetEnvForTests()
    try {
      await expect(deleteAccountData(dave, { store })).rejects.toBeInstanceOf(DeletionUnavailableError)
    } finally {
      if (previous !== undefined) process.env.QAVREN_ADMIN_CLIENT_SECRET = previous
      resetEnvForTests()
    }

    expect(await counts(dave)).toEqual(everyTable(1))
    expect(await listOwnerDocuments(store, dave)).toHaveLength(1)
  })
})

describe('deleteAccountData', () => {
  it('removes every row and object Alice owns, and nothing of Bob\'s', async () => {
    const admin = stubAdmin()

    const result = await deleteAccountData(alice, { store, admin })

    expect(result.rowsByTable).toEqual(everyTable(1))
    expect(result.objects).toBe(1)

    expect(await counts(alice)).toEqual(everyTable(0))
    expect(await counts(bob)).toEqual(everyTable(1))

    expect(await listOwnerDocuments(store, alice)).toEqual([])
    expect(await store.get(bobKey)).toEqual(pdfBytes)

    expect(admin.deleteUser).toHaveBeenCalledTimes(1)
    expect(admin.deleteUser).toHaveBeenCalledWith(alice, 'tok')
  }, 30_000)

  it('leaves the append-only ledger guard in force once the deletion transaction commits', async () => {
    await expect(db().delete(aiUsage).where(eq(aiUsage.ownerId, bob)))
      .rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(entitlements).where(eq(entitlements.ownerId, bob)))
      .rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect((await counts(bob)).ai_usage).toBe(1)
  })
})

/**
 * Postgres, R2 and Keycloak are three systems with no transaction between them,
 * so a failure after the rows commit is a real state a veteran can end up in.
 * What matters is that it is not a dead end: running the deletion again from
 * either residual state finishes the job.
 */
describe('deleteAccountData after a partial failure', () => {
  it('retries the object sweep when the store failed, leaving the rows already gone', async () => {
    const erin = freshOwner()
    await seed(erin, store)
    const admin = stubAdmin()
    const removeSpy = vi.spyOn(store, 'remove')
    removeSpy.mockRejectedValueOnce(new Error('bucket unreachable'))

    await expect(deleteAccountData(erin, { store, admin })).rejects.toThrow('bucket unreachable')

    expect(await counts(erin)).toEqual(everyTable(0))
    expect(await listOwnerDocuments(store, erin)).toHaveLength(1)
    expect(admin.deleteUser).not.toHaveBeenCalled()

    const retry = await deleteAccountData(erin, { store, admin })

    expect(retry.rowsByTable).toEqual(everyTable(0))
    expect(retry.objects).toBe(1)
    expect(await listOwnerDocuments(store, erin)).toEqual([])
    expect(admin.deleteUser).toHaveBeenCalledTimes(1)
    expect(admin.deleteUser).toHaveBeenCalledWith(erin, 'tok')
    removeSpy.mockRestore()
  })

  it('retries the identity delete when Keycloak failed, and is idempotent', async () => {
    const frank = freshOwner()
    await seed(frank, store)
    const admin = stubAdmin()
    admin.deleteUser.mockRejectedValueOnce(new Error('keycloak user delete returned 503'))

    await expect(deleteAccountData(frank, { store, admin })).rejects.toThrow('503')

    expect(await counts(frank)).toEqual(everyTable(0))
    expect(await listOwnerDocuments(store, frank)).toEqual([])

    const retry = await deleteAccountData(frank, { store, admin })

    expect(retry.rowsByTable).toEqual(everyTable(0))
    expect(retry.objects).toBe(0)
    expect(admin.deleteUser).toHaveBeenCalledTimes(2)
  })
})

describe('deleteAccountData verifies the cascade', () => {
  it('rolls back rather than report a row it did not remove', async () => {
    const grace = freshOwner()
    await seed(grace, store)

    // A row carrying Grace's owner_id whose case belongs to someone else: the
    // FK is valid, so it exists, but the cascade off Grace's case never reaches it.
    const stranger = freshOwner()
    const [strangerCase] = await db().insert(cases).values({ ownerId: stranger })
      .returning({ id: cases.id })
    await db().insert(serviceFacts).values({
      caseId: strangerCase.id, ownerId: grace, branch: 'Navy',
      dischargeDate: '2016-08-01', characterization: 'GeneralUnderHonorable',
    })

    const admin = stubAdmin()
    await expect(deleteAccountData(grace, { store, admin }))
      .rejects.toThrow(/survived the case cascade/)

    // The whole transaction rolled back, so nothing of Grace's went.
    const after = await counts(grace)
    expect(after.cases).toBe(1)
    expect(after.ai_usage).toBe(1)
    expect(after.entitlements).toBe(1)
    expect(after.drafts).toBe(1)
    expect(after.service_facts).toBe(2)
    expect(await listOwnerDocuments(store, grace)).toHaveLength(1)
    expect(admin.deleteUser).not.toHaveBeenCalled()

    await db().delete(serviceFacts).where(eq(serviceFacts.caseId, strangerCase.id))
    await db().delete(cases).where(eq(cases.id, strangerCase.id))
  })
})
