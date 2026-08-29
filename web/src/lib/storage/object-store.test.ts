import { describe, it, expect } from 'vitest'
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
