const SESSION_COOKIE = 'authjs.session-token'
const SECURE_PREFIX = '__Secure-'

/**
 * Auth.js's session cookie, either name, whole or as one of its `.0`, `.1`, …
 * chunks (a JWT over ~4 KB is split).
 */
export function isSessionCookieName(name: string): boolean {
  const bare = name.startsWith(SECURE_PREFIX) ? name.slice(SECURE_PREFIX.length) : name
  return bare === SESSION_COOKIE || /^authjs\.session-token\.\d+$/.test(bare)
}

// A Set-Cookie line that SETS a session cookie: non-empty value only. A deletion
// (`name=; Max-Age=0`) can never resurrect a session and must pass through, e.g.
// Auth.js clearing a cookie that no longer decrypts after a secret rotation.
const SESSION_COOKIE_HEADER = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=[^;]/

/**
 * Auth.js's middleware wrapper re-encodes the JWT and appends a refreshed
 * session cookie to EVERY response it wraps (sliding expiry). That makes any late
 * response — a Server Action, a `router.refresh()` or a prefetch still in flight
 * when the user signs out — resurrect the session the sign-out just deleted. The
 * proxy therefore never re-issues session cookies: sign-in sets the cookie
 * through Auth.js's own route, sign-out deletes it, and the session lives a
 * fixed `maxAge` in between. Every other Set-Cookie the wrapper emits
 * (callback-url, csrf, deletions) passes through untouched.
 *
 * Anything that is not a `Response` is returned as is.
 */
export function stripSessionRefresh<T>(res: T): T {
  if (!(res instanceof Response)) return res
  const cookies = res.headers.getSetCookie()
  if (!cookies.some((c) => SESSION_COOKIE_HEADER.test(c))) return res
  res.headers.delete('set-cookie')
  for (const c of cookies) if (!SESSION_COOKIE_HEADER.test(c)) res.headers.append('set-cookie', c)
  return res
}
