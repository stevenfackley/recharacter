import { getEnv, requireEnv } from '@/lib/env'
import type { ObjectStore } from './object-store'
import { S3ObjectStore } from './s3-object-store'

let store: ObjectStore | undefined

/** Production store from env (R2, or MinIO via S3_ENDPOINT). Tests inject their own. */
export function getObjectStore(): ObjectStore {
  if (store) return store
  const env = getEnv()
  const endpoint = env.S3_ENDPOINT ?? `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`
  store = new S3ObjectStore({
    endpoint,
    bucket: requireEnv('R2_BUCKET'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  })
  return store
}

export type { ObjectStore }
