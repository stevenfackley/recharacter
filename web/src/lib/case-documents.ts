import { randomUUID } from 'node:crypto'
import type { ObjectStore } from '@/lib/storage/object-store'

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
export type DocumentType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'

/** Magic-byte detection; the multipart Content-Type is client-controlled and ignored. */
export function sniffContentType(bytes: Uint8Array): DocumentType | null {
  const b = bytes
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

export function ownerPrefix(ownerId: string): string { return `${ownerId}/` }

export function documentKey(ownerId: string, caseId: string, originalName: string): string {
  const safeName = originalName.replace(/[^\w.\-]/g, '_').slice(0, 120) || 'document'
  return `${ownerPrefix(ownerId)}${caseId}/${randomUUID()}-${safeName}`
}

export class ForeignObjectError extends Error {}

/** The code-level replacement for storage RLS: a key must sit under the caller's prefix. */
export function assertOwnedKey(ownerId: string, key: string): void {
  if (!key.startsWith(ownerPrefix(ownerId))) throw new ForeignObjectError('object does not belong to this account')
}

export async function putCaseDocument(store: ObjectStore, ownerId: string, caseId: string, name: string, bytes: Uint8Array, contentType: DocumentType): Promise<string> {
  const key = documentKey(ownerId, caseId, name)
  assertOwnedKey(ownerId, key)
  await store.put(key, bytes, contentType)
  return key
}

export async function getCaseDocument(store: ObjectStore, ownerId: string, key: string): Promise<Uint8Array | null> {
  assertOwnedKey(ownerId, key)
  return store.get(key)
}

export async function listOwnerDocuments(store: ObjectStore, ownerId: string): Promise<string[]> {
  return store.list(ownerPrefix(ownerId))
}

/** Deletes every object under the owner's prefix and PROVES the prefix is empty afterwards. */
export async function removeOwnerDocuments(store: ObjectStore, ownerId: string): Promise<number> {
  const keys = await listOwnerDocuments(store, ownerId)
  if (keys.length) await store.remove(keys)
  const left = await listOwnerDocuments(store, ownerId)
  if (left.length) throw new Error(`${left.length} objects survived deletion sweep`)
  return keys.length
}
