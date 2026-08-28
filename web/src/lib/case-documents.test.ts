import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { MemoryObjectStore } from '@/lib/storage/object-store'
import {
  sniffContentType,
  documentKey,
  ownerPrefix,
  assertOwnedKey,
  ForeignObjectError,
  DocumentTooLargeError,
  UnsupportedDocumentError,
  MAX_DOCUMENT_BYTES,
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

  it('rejects a PNG with a wrong 5th signature byte', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a, 0x1a, 0x0a])
    expect(sniffContentType(bytes)).toBeNull()
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
  const owner = randomUUID()
  const caseId = randomUUID()

  it('sanitizes a path-traversal name and keeps a 3-part key', () => {
    const key = documentKey(owner, caseId, '../../etc/passwd')
    expect(key.startsWith(`${owner}/${caseId}/`)).toBe(true)
    expect(key.split('/').length).toBe(3)
  })

  it('falls back to "document" for an empty name', () => {
    const key = documentKey(owner, caseId, '')
    expect(key.endsWith('-document')).toBe(true)
  })

  it('truncates a long name to at most 120 chars while keeping the extension', () => {
    const longName = 'a'.repeat(300) + '.pdf'
    const key = documentKey(owner, caseId, longName)
    const namePart = key.split('/')[2]
    // namePart is `${uuid}-${safeName}`; uuid is 36 chars + '-' separator.
    const safeName = namePart.slice(37)
    expect(safeName).toBe('a'.repeat(116) + '.pdf')
  })

  it('rejects a non-UUID caseId', () => {
    expect(() => documentKey(owner, '../../x', 'a.pdf')).toThrow('invalid caseId')
  })

  it('rejects a non-UUID ownerId', () => {
    expect(() => documentKey('', caseId, 'a.pdf')).toThrow('invalid ownerId')
  })
})

describe('assertOwnedKey', () => {
  const owner = randomUUID()
  const caseId = randomUUID()

  it('allows a key under the owner prefix', () => {
    expect(() => assertOwnedKey(owner, `${owner}/${caseId}/doc`)).not.toThrow()
  })

  it('rejects a key under a different owner prefix', () => {
    const other = randomUUID()
    expect(() => assertOwnedKey(other, `${owner}/${caseId}/doc`)).toThrow(ForeignObjectError)
  })

  it('rejects a key equal to the owner id without a trailing slash', () => {
    expect(() => assertOwnedKey(owner, owner)).toThrow(ForeignObjectError)
  })

  it('ownerPrefix ends with a slash, and a sibling id with extra suffix is rejected', () => {
    expect(ownerPrefix(owner).endsWith('/')).toBe(true)
    expect(() => assertOwnedKey(owner, `${owner}x/${caseId}/doc`)).toThrow(ForeignObjectError)
  })

  it('rejects an empty ownerId', () => {
    expect(() => assertOwnedKey('', `/${caseId}/doc`)).toThrow('invalid ownerId')
  })
})

describe('case document helpers against MemoryObjectStore', () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

  it('putCaseDocument/getCaseDocument round-trip and sniff the content type', async () => {
    const store = new MemoryObjectStore()
    const owner = randomUUID()
    const caseId = randomUUID()
    const { key, contentType } = await putCaseDocument(store, owner, caseId, 'evidence.pdf', pdfBytes)
    expect(contentType).toBe('application/pdf')
    expect(await getCaseDocument(store, owner, key)).toEqual(pdfBytes)
  })

  it('putCaseDocument rejects bytes over MAX_DOCUMENT_BYTES', async () => {
    const store = new MemoryObjectStore()
    const owner = randomUUID()
    const caseId = randomUUID()
    const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1)
    await expect(putCaseDocument(store, owner, caseId, 'evidence.pdf', tooBig)).rejects.toThrow(DocumentTooLargeError)
  })

  it('putCaseDocument rejects content it cannot sniff', async () => {
    const store = new MemoryObjectStore()
    const owner = randomUUID()
    const caseId = randomUUID()
    const bytes = new TextEncoder().encode('hello')
    await expect(putCaseDocument(store, owner, caseId, 'evidence.txt', bytes)).rejects.toThrow(UnsupportedDocumentError)
  })

  it('removeOwnerDocuments sweeps only the owner prefix', async () => {
    const store = new MemoryObjectStore()
    const alice = randomUUID()
    const bob = randomUUID()
    const caseId = randomUUID()
    const aliceKeys = await Promise.all(
      [1, 2, 3].map(async (i) => (await putCaseDocument(store, alice, caseId, `doc${i}.pdf`, pdfBytes)).key),
    )
    const bobKeys = await Promise.all(
      [1, 2].map(async (i) => (await putCaseDocument(store, bob, caseId, `doc${i}.pdf`, pdfBytes)).key),
    )

    const removed = await removeOwnerDocuments(store, alice)
    expect(removed).toBe(3)

    const remaining = await listOwnerDocuments(store, bob)
    expect(remaining.sort()).toEqual([...bobKeys].sort())

    for (const key of aliceKeys) {
      expect(await store.get(key)).toBeNull()
    }
  })

  it('getCaseDocument rejects reading another owner key', async () => {
    const store = new MemoryObjectStore()
    const alice = randomUUID()
    const bob = randomUUID()
    const caseId = randomUUID()
    const { key: aliceKey } = await putCaseDocument(store, alice, caseId, 'doc.pdf', pdfBytes)
    await expect(getCaseDocument(store, bob, aliceKey)).rejects.toThrow(ForeignObjectError)
  })
})
