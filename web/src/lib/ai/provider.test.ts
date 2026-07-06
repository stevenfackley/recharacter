import { describe, expect, test } from 'vitest'
import { resolveApiKey } from '@/lib/ai/provider'
import { encryptSecret } from '@/lib/ai/crypto'

const KEK = Buffer.alloc(32).toString('base64')

describe('provider key resolution', () => {
  test('uses decrypted BYOK key when a credential exists', () => {
    const encrypted = encryptSecret('sk-user-own-key', KEK)
    const r = resolveApiKey({ encryptedByokKey: encrypted, kek: KEK, managedKey: 'sk-managed' })
    expect(r).toEqual({ apiKey: 'sk-user-own-key', byok: true })
  })

  test('falls back to managed key when no credential', () => {
    const r = resolveApiKey({ encryptedByokKey: null, kek: KEK, managedKey: 'sk-managed' })
    expect(r).toEqual({ apiKey: 'sk-managed', byok: false })
  })

  test('throws when neither key is available', () => {
    expect(() => resolveApiKey({ encryptedByokKey: null, kek: KEK, managedKey: undefined })).toThrow(
      /no ai key/i,
    )
  })

  test('a corrupted BYOK credential does NOT silently fall back to the managed key', () => {
    expect(() =>
      resolveApiKey({ encryptedByokKey: 'not-valid-ciphertext', kek: KEK, managedKey: 'sk-managed' }),
    ).toThrow()
  })
})
