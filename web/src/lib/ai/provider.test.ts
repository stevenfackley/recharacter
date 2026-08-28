import { describe, expect, test } from 'vitest'
import { resolveApiKey } from '@/lib/ai/provider'
import { encryptSecret } from '@/lib/ai/crypto'

const KEK = Buffer.alloc(32).toString('base64')
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222'

describe('provider key resolution', () => {
  test('uses decrypted BYOK key when a credential exists', () => {
    const encrypted = encryptSecret('sk-user-own-key', KEK, OWNER)
    const r = resolveApiKey({
      encryptedByokKey: encrypted, kek: KEK, aad: OWNER, managedKey: 'sk-managed',
    })
    expect(r).toEqual({ apiKey: 'sk-user-own-key', byok: true })
  })

  test('falls back to managed key when no credential', () => {
    const r = resolveApiKey({
      encryptedByokKey: null, kek: KEK, aad: OWNER, managedKey: 'sk-managed',
    })
    expect(r).toEqual({ apiKey: 'sk-managed', byok: false })
  })

  test('throws when neither key is available', () => {
    expect(() =>
      resolveApiKey({ encryptedByokKey: null, kek: KEK, aad: OWNER, managedKey: undefined }),
    ).toThrow(/no ai key/i)
  })

  test('a corrupted BYOK credential does NOT silently fall back to the managed key', () => {
    // Pinning the message is the point: a bare toThrow() would also pass if this
    // threw for having no managed key, which is the opposite of what is asserted.
    expect(() =>
      resolveApiKey({
        encryptedByokKey: 'not-valid-ciphertext', kek: KEK, aad: OWNER, managedKey: 'sk-managed',
      }),
    ).toThrow('malformed ciphertext')
  })

  test("another owner's ciphertext does NOT resolve to that owner's key", () => {
    // Same failure class as corruption: the AAD mismatch fails authentication,
    // so a mis-scoped credential can never be used — and never falls back either.
    const encrypted = encryptSecret('sk-user-own-key', KEK, OWNER)
    expect(() =>
      resolveApiKey({
        encryptedByokKey: encrypted, kek: KEK, aad: OTHER_OWNER, managedKey: 'sk-managed',
      }),
    ).toThrow(/unable to authenticate data/i)
  })
})
