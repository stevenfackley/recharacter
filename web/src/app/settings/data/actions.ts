'use server'

import { redirect } from 'next/navigation'
import { signOut } from '@/auth'
import { requireSessionUser } from '@/lib/session'
import { getObjectStore } from '@/lib/storage'
import { deleteAccountData, DeletionUnavailableError } from '@/lib/account'

/**
 * Permanent account deletion. Confirm-gated, and all-or-nothing in what it
 * promises: deleteAccountData proves the Keycloak service account before it
 * touches anything, so "unavailable" genuinely means nothing was removed and
 * the veteran is never shown success over a half-deleted account.
 *
 * Failures redirect with a CODE, never a message. `?error=` is rendered back
 * onto recharacter.us, and letting a caller choose those words on a page whose
 * users are already being asked for stigmatizing records is a phishing surface
 * (see lib/auth-errors.ts).
 */
export async function deleteAccount(formData: FormData) {
  const user = await requireSessionUser('/settings/data')

  if (formData.get('confirm') !== 'on') {
    redirect('/settings/data?error=confirm_phrase')
  }

  try {
    await deleteAccountData(user.id, { store: getObjectStore() })
  } catch (err) {
    if (err instanceof DeletionUnavailableError) {
      redirect('/settings/data?error=deletion_unavailable')
    }
    // The message is ours (or a client library's); the rows are not, and
    // nothing from them goes to a log.
    console.error('account deletion failed', {
      ownerId: user.id,
      message: err instanceof Error ? err.message : String(err),
    })
    redirect('/settings/data?error=deletion_failed')
  }

  // The Keycloak session died with the user; this clears our own cookie. If it
  // fails, the account is still gone and the cookie is already worthless — the
  // veteran must not be shown a deletion error over it.
  try {
    await signOut({ redirect: false })
  } catch (err) {
    console.error('sign-out after account deletion failed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
  redirect('/login?deleted=1')
}
