import { NextResponse, type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { issuerFor } from '@qavren/auth-next'
import { signOut } from '@/auth'
import { getEnv, requireEnv } from '@/lib/env'
import { isSessionCookieName } from '@/lib/session-cookies'

/**
 * Sign out of ReCharacter *and* of the realm.
 *
 * Dropping our own session cookie is not enough: Keycloak's SSO cookie would
 * survive, so the next "sign in" on a shared or library computer would hand the
 * account straight back without a password. RP-initiated logout ends the realm
 * session too, which is why the ID token is kept on the JWT at all.
 */
export async function POST(req: NextRequest) {
  const env = getEnv()
  const appBaseUrl = requireEnv('APP_BASE_URL')
  const appOrigin = new URL(appBaseUrl).origin

  // POST-only plus two cross-site checks: a cross-site form must not be able to
  // log someone out mid-petition. A same-origin form navigation sends no Origin,
  // hence `origin &&`; Sec-Fetch-Site closes that gap on browsers that send it
  // (`none` is a typed URL or bookmark, `same-origin` is our own page).
  const origin = req.headers.get('origin')
  const site = req.headers.get('sec-fetch-site')
  if ((origin && origin !== appOrigin) || (site && site !== 'same-origin' && site !== 'none')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Read the JWT straight off the request cookie rather than through `auth()`:
  // the ID token is never placed on the session object, because Auth.js serves
  // that object verbatim at GET /api/auth/session. `getToken` derives the cookie
  // name (`__Secure-authjs.session-token` over HTTPS, `authjs.session-token`
  // otherwise) from `secureCookie`, and reassembles chunked cookies. It must run
  // before signOut clears the session.
  const secure = new URL(appBaseUrl).protocol === 'https:'
  const jwt = await getToken({ req, secret: process.env.AUTH_SECRET ?? '', secureCookie: secure })
  const idToken = typeof jwt?.idToken === 'string' ? jwt.idToken : undefined

  await signOut({ redirect: false })

  const end = new URL(
    `${issuerFor(env.QAVREN_REALM, env.QAVREN_AUTH_URL)}/protocol/openid-connect/logout`,
  )
  end.searchParams.set('post_logout_redirect_uri', `${appBaseUrl}/login`)
  if (idToken) end.searchParams.set('id_token_hint', idToken)
  // Keycloak requires one of id_token_hint or client_id to honour the
  // post-logout redirect; without either it prompts for confirmation instead.
  else end.searchParams.set('client_id', `${env.QAVREN_REALM}-web`)

  const res = NextResponse.redirect(end, 303)
  // Belt and braces: Auth.js's own deletion rides on cookies(), and a refreshed
  // session cookie appended by anything else would race it. Delete what the
  // request actually carried (chunked cookies included), under the exact name it
  // carried — the `__Secure-` form needs the Secure attribute to be accepted.
  //
  // Both Max-Age=0 AND a past Expires: Next re-parses the response's Set-Cookie
  // headers when it merges cookies() mutations (appendMutableCookies) and its
  // compact() drops the falsy Max-Age, which would turn this deletion into an
  // empty-value cookie that also displaces Auth.js's own same-name deletion.
  for (const c of req.cookies.getAll()) {
    if (!isSessionCookieName(c.name)) continue
    res.cookies.set(c.name, '', {
      path: '/',
      maxAge: 0,
      expires: new Date(0),
      httpOnly: true,
      sameSite: 'lax',
      secure: c.name.startsWith('__Secure-'),
    })
  }
  return res
}
