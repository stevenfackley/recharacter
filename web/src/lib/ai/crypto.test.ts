import { describe, expect, test } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/ai/crypto'

// 32 zero bytes, base64 — test KEK only.
const KEK = Buffer.alloc(32).toString('base64')
// The AAD in production is the owner's Keycloak sub.
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222'

describe('BYOK crypto', () => {
  test('round-trips a secret', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    expect(decryptSecret(ct, KEK, OWNER)).toBe('sk-ant-api03-abc123')
  })

  test('ciphertext is not the plaintext and varies per call (random IV)', () => {
    const a = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    const b = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    expect(a).not.toContain('sk-ant')
    expect(a).not.toBe(b)
  })

  test('tampered ciphertext fails authentication', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    const buf = Buffer.from(ct, 'base64')
    buf[buf.length - 1] ^= 0xff // flip a bit in the auth tag
    expect(() => decryptSecret(buf.toString('base64'), KEK, OWNER)).toThrow()
  })

  test('wrong KEK fails', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    const otherKek = Buffer.alloc(32, 1).toString('base64')
    expect(() => decryptSecret(ct, otherKek, OWNER)).toThrow()
  })

  test("a ciphertext cannot be decrypted under another owner's AAD", () => {
    // The key is bound to the owner it was saved for: a credential row read for
    // the wrong owner is unusable rather than a leaked API key.
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    expect(() => decryptSecret(ct, KEK, OTHER_OWNER)).toThrow()
    expect(() => decryptSecret(ct, KEK, '')).toThrow()
  })
})
