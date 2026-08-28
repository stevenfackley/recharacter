// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { config } from 'dotenv'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3ObjectStore } from '@/lib/storage/s3-object-store'
import {
  putCaseDocument,
  getCaseDocument,
  removeOwnerDocuments,
  listOwnerDocuments,
  ForeignObjectError,
} from '@/lib/case-documents'

config({ path: '.env.local' })

describe.skipIf(!process.env.S3_ENDPOINT)('storage scoping against MinIO', () => {
  const endpoint = process.env.S3_ENDPOINT!
  const bucket = process.env.R2_BUCKET!
  const accessKeyId = process.env.R2_ACCESS_KEY_ID!
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!

  const store = new S3ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey })

  beforeAll(async () => {
    const client = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
    }
  })

  it('round-trips bytes for the owner that wrote them', async () => {
    const alice = randomUUID()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const key = await putCaseDocument(store, alice, 'case1', 'dd214.pdf', bytes, 'application/pdf')
    const got = await getCaseDocument(store, alice, key)
    expect(got).toEqual(bytes)
  })

  it('rejects a foreign owner reading another owner key', async () => {
    const alice = randomUUID()
    const bob = randomUUID()
    const bytes = new Uint8Array([9, 9, 9])
    const key = await putCaseDocument(store, alice, 'case1', 'dd214.pdf', bytes, 'application/pdf')
    await expect(getCaseDocument(store, bob, key)).rejects.toThrow(ForeignObjectError)
  })

  it('removeOwnerDocuments for an owner with nothing leaves other owners untouched', async () => {
    const alice = randomUUID()
    const bob = randomUUID()
    await putCaseDocument(store, alice, 'case1', 'dd214.pdf', new Uint8Array([1]), 'application/pdf')

    const removed = await removeOwnerDocuments(store, bob)
    expect(removed).toBe(0)

    const aliceKeys = await listOwnerDocuments(store, alice)
    expect(aliceKeys.length).toBe(1)
  })

  it('sweeps past MinIO\'s 1000-key listing page', async () => {
    const alice = randomUUID()
    const total = 1200
    const batchSize = 100
    for (let start = 0; start < total; start += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, total - start) }, (_, i) => start + i)
      await Promise.all(
        batch.map((i) => putCaseDocument(store, alice, 'case1', `doc${i}.pdf`, new Uint8Array([1]), 'application/pdf')),
      )
    }

    const removed = await removeOwnerDocuments(store, alice)
    expect(removed).toBe(total)

    const remaining = await listOwnerDocuments(store, alice)
    expect(remaining).toEqual([])
  }, 60_000)
})
