'use server'

import { signIn } from '@/auth'
import { safeNext } from '@/lib/session'

/**
 * Same authorization request as sign-in, with the OIDC `prompt=create` hint —
 * Keycloak >= 26.1 honours it by opening the registration form instead of the
 * login form. There is no separate registration endpoint to call.
 */
export async function signupAction(formData: FormData) {
  await signIn('keycloak', { redirectTo: safeNext(formData.get('next')) }, { prompt: 'create' })
}
