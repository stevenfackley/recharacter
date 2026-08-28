import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, NoSuchKey,
} from '@aws-sdk/client-s3'
import type { ObjectStore } from './object-store'

export type S3ObjectStoreOptions = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3ObjectStore implements ObjectStore {
  private client: S3Client
  private bucket: string
  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket
    this.client = new S3Client({
      region: 'auto',
      endpoint: opts.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    })
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: new Uint8Array(body), ContentType: contentType }))
  }
  async get(key: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return out.Body ? await out.Body.transformToByteArray() : null
    } catch (err) {
      if (err instanceof NoSuchKey) return null
      throw err
    }
  }
  async list(prefix: string) {
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return keys
  }
  async remove(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000)
      const out = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }))
      if (out.Errors?.length) throw new Error(`object delete failed for ${out.Errors.length} keys`)
    }
  }
}
