// @vitest-environment node
//
// The real GET handler of /api/account/export against the live database and
// the live object store. Only the session is stubbed: everything between the
// handler and Postgres/MinIO is the production code path, so what this proves
// is the file a veteran actually downloads — its headers, its shape, and that
// nothing of another account's and nothing of the BYOK ciphertext is in it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { db, freshOwner } from './helpers'
import { closeDb } from '@/db'
import {
  cases, serviceFacts, caseContext, evidenceItems, nexusAnswers, drafts,
  aiUsage, aiCredentials, entitlements, pendingCheckouts,
} from '@/db/schema'
import { getObjectStore } from '@/lib/storage'
import { putCaseDocument } from '@/lib/case-documents'
import { getSessionUser } from '@/lib/session'
import { GET } from '@/app/api/account/export/route'

// The route reads identity from exactly one place. Stubbing it here keeps
// next-auth and Keycloak out of the picture without touching anything else.
vi.mock('@/lib/session', () => ({ getSessionUser: vi.fn() }))

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%export route seed\n')

const EXPORT_KEYS = [
  'exportedAt', 'ownerId', 'case', 'serviceFacts', 'caseContext', 'evidenceItems', 'nexusAnswers',
  'drafts', 'aiUsage', 'entitlements', 'pendingCheckouts', 'aiCredentials', 'uploadedDocuments',
].sort()

/** Every table plus one stored object, every free-text column stamped with `tag`. */
async function seed(ownerId: string, tag: string) {
  const [c] = await db().insert(cases).values({ ownerId }).returning({ id: cases.id })
  const caseId = c.id
  const ciphertext = Buffer.from(`sk-ant-${tag}-${ownerId}`).toString('base64')
  const [{ key }] = await Promise.all([
    putCaseDocument(getObjectStore(), ownerId, caseId, `${tag}-dd214.pdf`, pdfBytes),
    db().insert(serviceFacts).values({
      caseId, ownerId, branch: 'Navy', dischargeDate: '2016-08-01', characterization: 'GeneralUnderHonorable',
    }),
    db().insert(caseContext).values({ caseId, ownerId, conditionCategory: 'tbi' }),
    db().insert(evidenceItems).values({ caseId, ownerId, itemType: 'buddy_statement', notes: `${tag} evidence note` }),
    db().insert(nexusAnswers).values({ caseId, ownerId, q1Condition: `${tag} nexus answer` }),
    db().insert(drafts).values({ caseId, ownerId, kind: 'cover_letter', content: `${tag} draft body` }),
    db().insert(aiUsage).values({ ownerId, task: `${tag}-task`, model: 'm', inputTokens: 1, outputTokens: 1 }),
    db().insert(aiCredentials).values({ ownerId, encryptedKey: ciphertext }),
    db().insert(entitlements).values({ ownerId, stripeSessionId: `cs_${tag}_${ownerId}` }),
    db().insert(pendingCheckouts).values({ ownerId, stripeSessionId: `cs_pending_${tag}_${ownerId}` }),
  ])
  return { caseId, key, ciphertext }
}

const alice = freshOwner()
const bob = freshOwner()
const ALICE_TAG = `ALICE_EXPORT_${alice.slice(0, 8)}`
const BOB_TAG = `BOB_EXPORT_${bob.slice(0, 8)}`
let aliceKey: string
let aliceCiphertext: string
let bobKey: string

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('GET /api/account/export', () => {
  beforeAll(async () => {
    // A fresh MinIO has no bucket; the app never creates one.
    const client = new S3Client({
      region: 'auto',
      endpoint: process.env.S3_ENDPOINT!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: process.env.R2_BUCKET! }))
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
    } finally {
      client.destroy()
    }
    ;({ key: aliceKey, ciphertext: aliceCiphertext } = await seed(alice, ALICE_TAG))
    ;({ key: bobKey } = await seed(bob, BOB_TAG))
  })

  afterAll(closeDb)

  it('refuses an anonymous request, and even that answer is uncacheable', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(null)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  it("hands Alice her whole record as a private JSON download, with nothing of Bob's and no ciphertext", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: alice, email: 'alice@example.test' })
    const res = await GET()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('vary')).toBe('Cookie')

    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(EXPORT_KEYS)
    expect(body.ownerId).toBe(alice)
    expect(body.case).toMatchObject({ owner_id: alice })
    expect(body.serviceFacts).toMatchObject({ branch: 'Navy', characterization: 'GeneralUnderHonorable' })
    expect(body.caseContext).toMatchObject({ condition_category: 'tbi' })
    expect(body.evidenceItems).toEqual([expect.objectContaining({ notes: `${ALICE_TAG} evidence note` })])
    expect(body.nexusAnswers).toMatchObject({ q1_condition: `${ALICE_TAG} nexus answer` })
    expect(body.drafts).toEqual([expect.objectContaining({ content: `${ALICE_TAG} draft body` })])
    expect(body.aiUsage).toEqual([expect.objectContaining({ task: `${ALICE_TAG}-task` })])
    expect(body.entitlements).toEqual([{ kind: 'case_unlock', created_at: expect.any(String) }])
    expect(body.pendingCheckouts).toEqual([
      { stripe_session_id: `cs_pending_${ALICE_TAG}_${alice}`, created_at: expect.any(String) },
    ])
    expect(body.uploadedDocuments).toEqual([aliceKey])

    // Bob: not his id, not his object key, not one seeded string of his.
    expect(text).not.toContain(bob)
    expect(text).not.toContain(bobKey)
    expect(text).not.toContain(BOB_TAG)

    // The BYOK credential is reported as a fact about the account, never as bytes.
    expect(body.aiCredentials).toEqual({ present: true, created_at: expect.any(String) })
    expect(text).not.toContain(aliceCiphertext)
    expect(text).not.toContain('encrypted_key')
    expect(text).not.toContain('encryptedKey')
    // No base64 blob of any kind: the longest legitimate runs in this document
    // are UUIDs and ISO timestamps, both broken up by punctuation well short of this.
    expect(text).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/)
  })
})
