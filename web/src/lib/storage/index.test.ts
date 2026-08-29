import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The production object-store factory: a process-wide singleton built from env,
 * R2 in prod (endpoint derived from the account id) and MinIO via S3_ENDPOINT
 * locally and in CI. The real S3ObjectStore is constructed; only the AWS SDK
 * client underneath is replaced so the config that reaches it can be read back.
 */

const s3ClientConfigs: Array<Record<string, unknown>> = []
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return {
    ...actual,
    S3Client: class MockS3Client {
      send = vi.fn()
      constructor(config: Record<string, unknown>) {
        s3ClientConfigs.push(config)
      }
    },
  }
})

type R2Var = 'R2_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_BUCKET'
type StorageVar = R2Var | 'S3_ENDPOINT'

const R2_ENV: Record<R2Var, string> = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET: 'bucket',
}

/** Stubs every storage variable: the full R2 set, S3_ENDPOINT unset, overrides last. */
function stubStorageEnv(over: Partial<Record<StorageVar, string | undefined>> = {}) {
  const all: Record<StorageVar, string | undefined> = { S3_ENDPOINT: undefined, ...R2_ENV, ...over }
  for (const [k, v] of Object.entries(all)) vi.stubEnv(k, v)
}

beforeEach(async () => {
  vi.resetModules()
  s3ClientConfigs.length = 0
  const { resetEnvForTests } = await import('@/lib/env')
  resetEnvForTests()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  const { resetEnvForTests } = await import('@/lib/env')
  resetEnvForTests()
})

describe('getObjectStore', () => {
  it('returns an S3ObjectStore when S3_ENDPOINT and R2 vars are set', async () => {
    stubStorageEnv({ S3_ENDPOINT: 'http://127.0.0.1:9100' })

    const { getObjectStore } = await import('./index')
    const { S3ObjectStore } = await import('./s3-object-store')
    expect(getObjectStore()).toBeInstanceOf(S3ObjectStore)
  })

  it('is a singleton: two calls return the same instance and build ONE client', async () => {
    stubStorageEnv({ S3_ENDPOINT: 'http://127.0.0.1:9100' })

    const { getObjectStore } = await import('./index')
    const first = getObjectStore()
    const second = getObjectStore()

    expect(second).toBe(first)
    expect(s3ClientConfigs).toHaveLength(1)
  })

  it('uses S3_ENDPOINT verbatim when set (MinIO locally and in CI)', async () => {
    stubStorageEnv({ S3_ENDPOINT: 'http://127.0.0.1:9100' })

    const { getObjectStore } = await import('./index')
    getObjectStore()

    expect(s3ClientConfigs[0].endpoint).toBe('http://127.0.0.1:9100')
  })

  it('with S3_ENDPOINT set, R2_ACCOUNT_ID is not required', async () => {
    stubStorageEnv({ S3_ENDPOINT: 'http://127.0.0.1:9100', R2_ACCOUNT_ID: undefined })

    const { getObjectStore } = await import('./index')
    expect(() => getObjectStore()).not.toThrow()
  })

  it('without S3_ENDPOINT the R2 endpoint is derived from R2_ACCOUNT_ID', async () => {
    stubStorageEnv()

    const { getObjectStore } = await import('./index')
    getObjectStore()

    expect(s3ClientConfigs).toHaveLength(1)
    expect(s3ClientConfigs[0]).toEqual({
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    })
  })

  it.each([
    ['R2_ACCOUNT_ID', {}],
    ['R2_BUCKET', {}],
    ['R2_ACCESS_KEY_ID', {}],
    ['R2_SECRET_ACCESS_KEY', {}],
    // The bucket and credentials are needed on the MinIO path too.
    ['R2_BUCKET', { S3_ENDPOINT: 'http://127.0.0.1:9100' }],
    ['R2_ACCESS_KEY_ID', { S3_ENDPOINT: 'http://127.0.0.1:9100' }],
    ['R2_SECRET_ACCESS_KEY', { S3_ENDPOINT: 'http://127.0.0.1:9100' }],
  ] as const)('throws a message naming %s when it is unset (%o)', async (missing, extra) => {
    stubStorageEnv({ ...extra, [missing]: undefined })

    const { getObjectStore } = await import('./index')
    expect(() => getObjectStore()).toThrow(`Missing required environment variable ${missing}`)
    // Nothing half-built: no client was constructed for a store that failed.
    expect(s3ClientConfigs).toHaveLength(0)
  })

  it('a failed construction is not memoized — once the env is fixed the next call succeeds', async () => {
    stubStorageEnv({ R2_BUCKET: undefined })

    const { getObjectStore } = await import('./index')
    expect(() => getObjectStore()).toThrow(/R2_BUCKET/)

    vi.stubEnv('R2_BUCKET', 'bucket')
    const { resetEnvForTests } = await import('@/lib/env')
    resetEnvForTests()

    expect(() => getObjectStore()).not.toThrow()
    expect(s3ClientConfigs).toHaveLength(1)
  })
})
