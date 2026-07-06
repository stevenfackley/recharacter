import Anthropic from '@anthropic-ai/sdk'
import { decryptSecret } from '@/lib/ai/crypto'

export type ResolvedKey = { apiKey: string; byok: boolean }

/**
 * BYOK wins when present. A corrupted BYOK credential throws rather than silently
 * falling back to the managed key — otherwise a user who believes their own key is
 * in use (privacy + billing expectation) would silently start billing the app's key.
 */
export function resolveApiKey(opts: {
  encryptedByokKey: string | null
  kek: string
  managedKey: string | undefined
}): ResolvedKey {
  if (opts.encryptedByokKey) {
    return { apiKey: decryptSecret(opts.encryptedByokKey, opts.kek), byok: true }
  }
  if (opts.managedKey) return { apiKey: opts.managedKey, byok: false }
  throw new Error('No AI key available: user has no BYOK credential and no managed key is configured')
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}
