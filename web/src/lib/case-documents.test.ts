import { describe, it, expect } from 'vitest'
import { MemoryObjectStore } from '@/lib/storage/object-store'
import {
  sniffContentType,
  documentKey,
  assertOwnedKey,
  ForeignObjectError,
  putCaseDocument,
  getCaseDocument,
  listOwnerDocuments,
  removeOwnerDocuments,
} from './case-documents'

describe('sniffContentType', () => {
  it('detects pdf', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    expect(sniffContentType(bytes)).toBe('application/pdf')
  })

  it('detects jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])
    expect(sniffContentType(bytes)).toBe('image/jpeg')
  })

  it('detects png', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(sniffContentType(bytes)).toBe('image/png')
  })

  it('detects webp', () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    expect(sniffContentType(bytes)).toBe('image/webp')
  })

  it('returns null for plain text', () => {
    const bytes = new TextEncoder().encode('hello')
    expect(sniffContentType(bytes)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(sniffContentType(new Uint8Array([]))).toBeNull()
  })
})

describe('documentKey', () => {
  it('sanitizes a path-traversal name and keeps a 3-part key', () => {
    const key = documentKey('owner1', 'case1', '../../etc/passwd')
    expect(key.startsWith('owner1/case1/')).toBe(true)
    expect(key.split('/').length).toBe(3)
  })

  it('falls back to "document" for an empty name', () => {
    const key = documentKey('owner1', 'case1', '')
    expect(key.endsWith('-document')).toBe(true)
  })

  it('truncates a long name to at most 120 chars', () => {
    const longName = 'a'.repeat(300) + '.pdf'
    const key = documentKey('owner1', 'case1', longName)
    const namePart = key.split('/')[2]
    // namePart is `${uuid}-${safeName}`; uuid is 36 chars + '-' separator.
    const safeName = namePart.slice(37)
    expect(safeName.length).toBeLessThanOrEqual(120)
  })
})

describe('assertOwnedKey', () => {
  it('allows a key under the owner prefix', () => {
    expect(() => assertOwnedKey('alice', 'alice/case1/doc')).not.toThrow()
  })

  it('rejects a key under a different owner prefix', () => {
    expect(() => assertOwnedKey('bob', 'alice/case1/doc')).toThrow(ForeignObjectError)
  })

  it('rejects a key equal to the owner id without a trailing slash', () => {
    expect(() => assertOwnedKey('alice', 'alice')).toThrow(ForeignObjectError)
  })
})

describe('case document helpers against MemoryObjectStore', () => {
  it('putCaseDocument/getCaseDocument round-trip', async () => {
    const store = new MemoryObjectStore()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const key = await putCaseDocument(store, 'alice', 'case1', 'evidence.pdf', bytes, 'application/pdf')
    expect(await getCaseDocument(store, 'alice', key)).toEqual(bytes)
  })

  it('removeOwnerDocuments sweeps only the owner prefix', async () => {
    const store = new MemoryObjectStore()
    const aliceKeys = await Promise.all(
      [1, 2, 3].map((i) => putCaseDocument(store, 'alice', 'case1', `doc${i}.pdf`, new Uint8Array([i]), 'application/pdf')),
    )
    const bobKeys = await Promise.all(
      [1, 2].map((i) => putCaseDocument(store, 'bob', 'case1', `doc${i}.pdf`, new Uint8Array([i]), 'application/pdf')),
    )

    const removed = await removeOwnerDocuments(store, 'alice')
    expect(removed).toBe(3)

    const remaining = await listOwnerDocuments(store, 'bob')
    expect(remaining.sort()).toEqual([...bobKeys].sort())

    for (const key of aliceKeys) {
      expect(await store.get(key)).toBeNull()
    }
  })

  it('getCaseDocument rejects reading another owner key', async () => {
    const store = new MemoryObjectStore()
    const aliceKey = await putCaseDocument(store, 'alice', 'case1', 'doc.pdf', new Uint8Array([1]), 'application/pdf')
    await expect(getCaseDocument(store, 'bob', aliceKey)).rejects.toThrow(ForeignObjectError)
  })
})
