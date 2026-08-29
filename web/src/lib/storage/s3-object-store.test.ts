import { describe, it, expect, vi } from 'vitest'
import {
  ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand,
} from '@aws-sdk/client-s3'
import { S3ObjectStore } from './s3-object-store'

function makeStore() {
  const store = new S3ObjectStore({
    endpoint: 'http://127.0.0.1:9100',
    bucket: 'test-bucket',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })
  const send = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(store as any).client.send = send
  return { store, send }
}

describe('S3ObjectStore.list', () => {
  it('follows pagination and returns every key across pages', async () => {
    const { store, send } = makeStore()
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'a' }, { Key: 'b' }],
        IsTruncated: true,
        NextContinuationToken: 't',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'c' }],
        IsTruncated: false,
      })

    const keys = await store.list('prefix/')

    expect(keys).toEqual(['a', 'b', 'c'])
    expect(send).toHaveBeenCalledTimes(2)
    const firstCommand = send.mock.calls[0][0] as ListObjectsV2Command
    const secondCommand = send.mock.calls[1][0] as ListObjectsV2Command
    expect(firstCommand.input.ContinuationToken).toBeUndefined()
    expect(secondCommand.input.ContinuationToken).toBe('t')
  })
})

describe('S3ObjectStore.remove', () => {
  it('chunks 2500 keys into 1000/1000/500 DeleteObjects sends with Quiet:true', async () => {
    const { store, send } = makeStore()
    send.mockResolvedValue({ Errors: [] })

    const keys = Array.from({ length: 2500 }, (_, i) => `key-${i}`)
    await store.remove(keys)

    expect(send).toHaveBeenCalledTimes(3)
    const sizes = send.mock.calls.map(([cmd]) => (cmd as DeleteObjectsCommand).input.Delete?.Objects?.length)
    expect(sizes).toEqual([1000, 1000, 500])
    for (const [cmd] of send.mock.calls) {
      expect((cmd as DeleteObjectsCommand).input.Delete?.Quiet).toBe(true)
    }
  })
})

describe('S3ObjectStore.get', () => {
  it('returns null when the SDK error name is NoSuchKey', async () => {
    const { store, send } = makeStore()
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
    expect(await store.get('missing-key')).toBeNull()
  })

  it('returns null when the error carries a 404 status but a different name', async () => {
    const { store, send } = makeStore()
    send.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'SomethingElse', $metadata: { httpStatusCode: 404 } }),
    )
    expect(await store.get('missing-key')).toBeNull()
  })

  it('rethrows an unrelated error', async () => {
    const { store, send } = makeStore()
    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'AccessDenied' }))
    await expect(store.get('forbidden-key')).rejects.toThrow('nope')
  })

  it('reads the body on success', async () => {
    const { store, send } = makeStore()
    const bytes = new Uint8Array([1, 2, 3])
    send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => bytes } })
    expect(await store.get('ok-key')).toEqual(bytes)
    const cmd = send.mock.calls[0][0] as GetObjectCommand
    expect(cmd.input.Key).toBe('ok-key')
  })
})
