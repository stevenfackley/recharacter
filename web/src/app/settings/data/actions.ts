'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { deleteAccountData } from '@/lib/account'

/**
 * Permanent account deletion. Confirm-gated, and all-or-nothing in what it
 * promises: if the service-role client is unavailable or any step fails, the
 * action reports failure and the veteran's data is NOT left half-deleted with
 * a success message. (Storage is swept before the auth-user cascade, so the
 * worst partial state is "documents gone, rows pending retry" — never the
 * reverse, which would strand orphaned files.)
 */
export async function deleteAccount(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (formData.get('confirm') !== 'on') {
    redirect('/settings/data?error=' + encodeURIComponent(
      'Check the confirmation box to delete your account',
    ))
  }

  const admin = createAdminClient()
  if (!admin) {
    redirect('/settings/data?error=' + encodeURIComponent(
      'Deletion is temporarily unavailable — nothing was removed. Please try again later.',
    ))
  }

  try {
    await deleteAccountData({ userClient: supabase, adminClient: admin, userId: user.id })
  } catch (err) {
    console.error('account deletion failed', err)
    redirect('/settings/data?error=' + encodeURIComponent(
      'Deletion did not complete — please try again',
    ))
  }

  await supabase.auth.signOut()
  redirect('/')
}
