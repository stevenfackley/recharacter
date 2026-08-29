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
  // A shape check, not a validity check: nothing here can prove a key works, but
  // catching a pasted-wrong-field mistake now beats storing it and failing at the
  // provider later, on a page that no longer has the value to correct.
  if (!apiKey || !apiKey.startsWith('sk-ant-')) redirect('/settings/ai?error=invalid_key')

  // Our misconfiguration, not their key — say so with its own code rather than
  // sending them off to re-enter a key that is fine.
  let kek: string | null = null
  try {
    kek = getEnv().AI_KEY_ENCRYPTION_SECRET ?? null
  } catch (err) {
    console.error('AI_KEY_ENCRYPTION_SECRET is unusable:', err instanceof Error ? err.message : err)
  }
  if (!kek) redirect('/settings/ai?error=kek_missing')

  let failed = false
  try {
    // The ciphertext is bound to its owner (AAD): a row read for anyone else
    // cannot be turned back into a usable key.
    await saveEncryptedKey(user.id, encryptSecret(apiKey, kek, user.id))
  } catch {
    // Deliberately NOT the underlying message. A client library that echoes the
    // value it choked on would put the veteran's API key straight into our logs,
    // which is the one thing this whole path exists to prevent. The owner id is
    // enough to find the row; the failure itself is visible in the store's own
    // telemetry.
    failed = true
  }
  if (failed) {
    console.error('byok key save failed for owner', user.id)
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
