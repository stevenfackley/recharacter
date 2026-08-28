import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

/**
 * `aad` binds a ciphertext to the owner it was encrypted for (pass the owner id).
 * GCM authenticates it without storing it, so a credential row copied — or
 * mis-joined — onto another owner fails to decrypt instead of handing that owner
 * someone else's API key. This is the crypto half of the owner scoping the rest
 * of the data layer does in SQL.
 *
 * The cutover provisions a fresh database, so there are no AAD-less ciphertexts
 * to stay compatible with: every payload must authenticate its owner.
 */

/** Encrypts a secret under the base64-encoded 32-byte KEK. Output: base64(iv || ciphertext || tag). */
export function encryptSecret(plaintext: string, kekBase64: string, aad: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, kek, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64')
}

export function decryptSecret(payloadBase64: string, kekBase64: string, aad: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const payload = Buffer.from(payloadBase64, 'base64')
  // Below iv + tag + one byte of ciphertext the subarrays below start lying:
  // the IV and the tag overlap, and the ciphertext slice comes back empty. Node
  // then fails with whatever it happens to fail with (or, for a short tag, an
  // error about tag length), which reads like a crypto problem rather than the
  // truncated input it is. Reject the shape up front.
  if (payload.length < IV_LEN + TAG_LEN + 1) throw new Error('malformed ciphertext')
  const iv = payload.subarray(0, IV_LEN)
  const tag = payload.subarray(payload.length - TAG_LEN)
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN)
  const decipher = createDecipheriv(ALG, kek, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
