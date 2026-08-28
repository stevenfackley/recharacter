import { NextResponse } from 'next/server'
import { issuerFor } from '@qavren/auth-next'
import { auth, signOut } from '@/auth'
import { getEnv } from '@/lib/env'

/**
 * Sign out of ReCharacter *and* of the realm.
 *
 * Dropping our own session cookie is not enough: Keycloak's SSO cookie would
 * survive, so the next "sign in" on a shared or library computer would hand the
 * account straight back without a password. RP-initiated logout ends the realm
 * session too, which is why the ID token is kept on the JWT at all.
 */
export async function POST(req: Request) {
  const env = getEnv()

  // POST-only plus an origin check: a cross-site form must not be able to log
  // someone out mid-petition. A same-origin form navigation sends no Origin.
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(env.APP_BASE_URL).origin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const session = await auth()
  await signOut({ redirect: false })

  const end = new URL(`${issuerFor(env.QAVREN_REALM, env.QAVREN_AUTH_URL)}/protocol/openid-connect/logout`)
  end.searchParams.set('post_logout_redirect_uri', `${env.APP_BASE_URL}/login`)
  if (session?.idToken) end.searchParams.set('id_token_hint', session.idToken)
  // Keycloak requires one of id_token_hint or client_id to honour the
  // post-logout redirect; without the hint it prompts for confirmation instead.
  else end.searchParams.set('client_id', `${env.QAVREN_REALM}-web`)

  return NextResponse.redirect(end, 303)
}
