'use server'

import { signIn } from '@/auth'
import { safeNext } from '@/lib/session'

/** Hands off to the realm's sign-in screen; Auth.js completes the PKCE dance. */
export async function loginAction(formData: FormData) {
  await signIn('keycloak', { redirectTo: safeNext(formData.get('next')) })
}
