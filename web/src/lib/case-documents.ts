import { randomUUID } from 'node:crypto'
import type { ObjectStore } from '@/lib/storage/object-store'

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
export type DocumentType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertId(kind: 'ownerId' | 'caseId', v: string) {
  if (!UUID.test(v)) throw new Error(`invalid ${kind}`)
}

/** Magic-byte detection; the multipart Content-Type is client-controlled and ignored. */
export function sniffContentType(bytes: Uint8Array): DocumentType | null {
  const b = bytes
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

export function ownerPrefix(ownerId: string): string {
  assertId('ownerId', ownerId)
  return `${ownerId}/`
}

export function documentKey(ownerId: string, caseId: string, originalName: string): string {
  assertId('ownerId', ownerId)
  assertId('caseId', caseId)
  const sanitized = originalName.replace(/[^\w.\-]/g, '_')
  const extMatch = /\.[\w]{1,10}$/.exec(sanitized)
  const ext = extMatch ? extMatch[0] : ''
  const stem = ext ? sanitized.slice(0, sanitized.length - ext.length) : sanitized
  const maxStemLen = Math.max(0, 120 - ext.length)
  const safeName = (stem.slice(0, maxStemLen) + ext) || 'document'
  return `${ownerPrefix(ownerId)}${caseId}/${randomUUID()}-${safeName}`
}

export class ForeignObjectError extends Error {}
export class DocumentTooLargeError extends Error {}
export class UnsupportedDocumentError extends Error {}

/** The code-level replacement for storage RLS: a key must sit under the caller's prefix. */
export function assertOwnedKey(ownerId: string, key: string): void {
  assertId('ownerId', ownerId)
  if (!key.startsWith(ownerPrefix(ownerId))) throw new ForeignObjectError('object does not belong to this account')
}

export async function putCaseDocument(
  store: ObjectStore,
  ownerId: string,
  caseId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ key: string; contentType: DocumentType }> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError('document exceeds the maximum allowed size')
  const contentType = sniffContentType(bytes)
  if (!contentType) throw new UnsupportedDocumentError('document content type could not be determined')
  const key = documentKey(ownerId, caseId, name)
  assertOwnedKey(ownerId, key)
  await store.put(key, bytes, contentType)
  return { key, contentType }
}

export async function getCaseDocument(store: ObjectStore, ownerId: string, key: string): Promise<Uint8Array | null> {
  assertOwnedKey(ownerId, key)
  return store.get(key)
}

export async function listOwnerDocuments(store: ObjectStore, ownerId: string): Promise<string[]> {
  return store.list(ownerPrefix(ownerId))
}

/**
 * Deletes every object under the owner's prefix. Sweeps up to 3 list->remove passes
 * (objects can reappear in a listing between the list and the remove call under
 * eventual consistency) and only throws if something survives the third pass.
 */
export async function removeOwnerDocuments(store: ObjectStore, ownerId: string): Promise<number> {
  assertId('ownerId', ownerId)
  let totalRemoved = 0
  let keys = await listOwnerDocuments(store, ownerId)
  for (let pass = 0; pass < 3 && keys.length; pass += 1) {
    await store.remove(keys)
    totalRemoved += keys.length
    keys = await listOwnerDocuments(store, ownerId)
  }
  if (keys.length) throw new Error(`${keys.length} objects survived deletion sweep`)
  return totalRemoved
}
