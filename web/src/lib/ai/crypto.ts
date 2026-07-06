import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

/** Encrypts a secret under the base64-encoded 32-byte KEK. Output: base64(iv || ciphertext || tag). */
export function encryptSecret(plaintext: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, kek, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64')
}

export function decryptSecret(payloadBase64: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const payload = Buffer.from(payloadBase64, 'base64')
  const iv = payload.subarray(0, IV_LEN)
  const tag = payload.subarray(payload.length - TAG_LEN)
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN)
  const decipher = createDecipheriv(ALG, kek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
