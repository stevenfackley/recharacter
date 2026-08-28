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
    // The GCM tag check, not a length or parse failure: pin the message so a
    // future refactor cannot pass this test by throwing earlier for some other
    // reason.
    expect(() => decryptSecret(buf.toString('base64'), KEK, OWNER))
      .toThrow(/unable to authenticate data/i)
  })

  test('wrong KEK fails', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    const otherKek = Buffer.alloc(32, 1).toString('base64')
    expect(() => decryptSecret(ct, otherKek, OWNER)).toThrow(/unable to authenticate data/i)
  })

  test('a KEK of the wrong size is rejected by name', () => {
    expect(() => decryptSecret('anything', Buffer.alloc(16).toString('base64'), OWNER))
      .toThrow('KEK must be 32 bytes (base64-encoded)')
  })

  test("a ciphertext cannot be decrypted under another owner's AAD", () => {
    // The key is bound to the owner it was saved for: a credential row read for
    // the wrong owner is unusable rather than a leaked API key.
    const ct = encryptSecret('sk-ant-api03-abc123', KEK, OWNER)
    expect(() => decryptSecret(ct, KEK, OTHER_OWNER)).toThrow(/unable to authenticate data/i)
    expect(() => decryptSecret(ct, KEK, '')).toThrow(/unable to authenticate data/i)
  })

  test('a payload too short to hold iv + tag + ciphertext is rejected up front', () => {
    // Below this length the slices overlap: the "tag" is cut out of the IV and
    // the ciphertext comes back empty, so Node fails with something about tag
    // length instead of the truncation that actually happened.
    const shortest = Buffer.alloc(12 + 16 + 1)
    expect(() => decryptSecret(shortest.subarray(0, 28).toString('base64'), KEK, OWNER))
      .toThrow('malformed ciphertext')
    expect(() => decryptSecret('', KEK, OWNER)).toThrow('malformed ciphertext')
    expect(() => decryptSecret('not-valid-ciphertext', KEK, OWNER)).toThrow('malformed ciphertext')
    // One byte more and it is a well-formed shape that fails authentication instead.
    expect(() => decryptSecret(shortest.toString('base64'), KEK, OWNER))
      .toThrow(/unable to authenticate data/i)
  })
})
