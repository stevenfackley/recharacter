import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MemoryObjectStore } from './object-store'

describe('MemoryObjectStore', () => {
  it('round-trips put/get', async () => {
    const store = new MemoryObjectStore()
    const body = new Uint8Array([1, 2, 3])
    await store.put('a/b/c', body, 'application/octet-stream')
    expect(await store.get('a/b/c')).toEqual(body)
  })

  it('copies on put: mutating the caller\'s buffer afterwards does not affect the stored copy', async () => {
    const store = new MemoryObjectStore()
    const body = new Uint8Array([1, 2, 3])
    await store.put('a', body, 'application/octet-stream')
    body[0] = 99
    expect(await store.get('a')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('copies on get: mutating the returned array does not affect the stored copy', async () => {
    const store = new MemoryObjectStore()
    await store.put('a', new Uint8Array([1, 2, 3]), 'application/octet-stream')
    const got = await store.get('a')
    got![0] = 99
    expect(await store.get('a')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('get returns null for missing key', async () => {
    const store = new MemoryObjectStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('list returns sorted keys only under prefix', async () => {
    const store = new MemoryObjectStore()
    await store.put('alice/1', new Uint8Array([1]), 'text/plain')
    await store.put('alice/3', new Uint8Array([1]), 'text/plain')
    await store.put('alice/2', new Uint8Array([1]), 'text/plain')
    await store.put('bob/1', new Uint8Array([1]), 'text/plain')
    expect(await store.list('alice/')).toEqual(['alice/1', 'alice/2', 'alice/3'])
  })

  it('remove deletes given keys', async () => {
    const store = new MemoryObjectStore()
    await store.put('a', new Uint8Array([1]), 'text/plain')
    await store.put('b', new Uint8Array([1]), 'text/plain')
    await store.remove(['a'])
    expect(await store.list('')).toEqual(['b'])
  })
})

describe('getObjectStore', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(async () => {
    vi.resetModules()
    const { resetEnvForTests } = await import('@/lib/env')
    resetEnvForTests()
  })

  afterEach(async () => {
    process.env = { ...OLD_ENV }
    const { resetEnvForTests } = await import('@/lib/env')
    resetEnvForTests()
  })

  it('returns an S3ObjectStore when S3_ENDPOINT and R2 vars are set', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9100'
    process.env.R2_ACCOUNT_ID = 'local'
    process.env.R2_ACCESS_KEY_ID = 'minio'
    process.env.R2_SECRET_ACCESS_KEY = 'minio12345'
    process.env.R2_BUCKET = 'recharacter-test'

    const { getObjectStore } = await import('./index')
    const { S3ObjectStore } = await import('./s3-object-store')
    const store = getObjectStore()
    expect(store).toBeInstanceOf(S3ObjectStore)
  })

  it('throws a message naming R2_BUCKET when unset', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9100'
    process.env.R2_ACCOUNT_ID = 'local'
    process.env.R2_ACCESS_KEY_ID = 'minio'
    process.env.R2_SECRET_ACCESS_KEY = 'minio12345'
    delete process.env.R2_BUCKET

    const { getObjectStore } = await import('./index')
    expect(() => getObjectStore()).toThrow(/R2_BUCKET/)
  })
})
