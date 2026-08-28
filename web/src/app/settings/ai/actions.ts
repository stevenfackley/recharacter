'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireSessionUser } from '@/lib/session'
import { getEnv } from '@/lib/env'
import { encryptSecret } from '@/lib/ai/crypto'
import { saveEncryptedKey, deleteEncryptedKey } from '@/lib/ai/credentials'

/**
 * BYOK key management. Failures leave as `?error=<code>` rather than a thrown
 * Error: an unhandled throw here reaches the veteran as a blank error boundary,
 * and the message would be ours to leak. The key itself never appears in a log,
 * a URL, or an error.
 */

export async function saveByokKey(formData: FormData) {
  const user = await requireSessionUser('/settings/ai')

  const apiKey = String(formData.get('apiKey') ?? '').trim()
  if (!apiKey) redirect('/settings/ai?error=invalid_key')

  // Our misconfiguration, not their key — say so with its own code rather than
  // sending them off to re-enter a key that is fine.
  let kek: string | null = null
  try {
    kek = getEnv().AI_KEY_ENCRYPTION_SECRET ?? null
  } catch (err) {
    console.error('AI_KEY_ENCRYPTION_SECRET is unusable:', err instanceof Error ? err.message : err)
  }
  if (!kek) redirect('/settings/ai?error=kek_missing')

  try {
    // The ciphertext is bound to its owner (AAD): a row read for anyone else
    // cannot be turned back into a usable key.
    await saveEncryptedKey(user.id, encryptSecret(apiKey, kek, user.id))
  } catch (err) {
    console.error('byok key save failed:', err instanceof Error ? err.message : err)
    redirect('/settings/ai?error=save_failed')
  }
  revalidatePath('/settings/ai')
}

export async function removeByokKey() {
  const user = await requireSessionUser('/settings/ai')

  try {
    await deleteEncryptedKey(user.id)
  } catch (err) {
    console.error('byok key removal failed:', err instanceof Error ? err.message : err)
    redirect('/settings/ai?error=remove_failed')
  }
  revalidatePath('/settings/ai')
}
