import { describe, expect, test } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/ai/crypto'

// 32 zero bytes, base64 — test KEK only.
const KEK = Buffer.alloc(32).toString('base64')

describe('BYOK crypto', () => {
  test('round-trips a secret', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    expect(decryptSecret(ct, KEK)).toBe('sk-ant-api03-abc123')
  })

  test('ciphertext is not the plaintext and varies per call (random IV)', () => {
    const a = encryptSecret('sk-ant-api03-abc123', KEK)
    const b = encryptSecret('sk-ant-api03-abc123', KEK)
    expect(a).not.toContain('sk-ant')
    expect(a).not.toBe(b)
  })

  test('tampered ciphertext fails authentication', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    const buf = Buffer.from(ct, 'base64')
    buf[buf.length - 1] ^= 0xff // flip a bit in the auth tag
    expect(() => decryptSecret(buf.toString('base64'), KEK)).toThrow()
  })

  test('wrong KEK fails', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    const otherKek = Buffer.alloc(32, 1).toString('base64')
    expect(() => decryptSecret(ct, otherKek)).toThrow()
  })
})
