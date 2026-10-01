import { beforeEach, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetEnvForTests } from '@/lib/env'

const getToken = vi.fn()
const signOut = vi.fn()

vi.mock('next-auth/jwt', () => ({ getToken }))
vi.mock('@/auth', () => ({ signOut }))

const { POST } = await import('./route')

const LOGOUT = 'https://auth.recharacter.us/realms/recharacter/protocol/openid-connect/logout'

beforeEach(() => {
  getToken.mockReset()
  signOut.mockReset()
  getToken.mockResolvedValue({ sub: 'u', idToken: 'idt' })
  process.env.APP_BASE_URL = 'http://localhost:3000'
  resetEnvForTests()
})

function post(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/auth/signout', { method: 'POST', headers })
}

test('a cross-origin post is refused and nothing is signed out', async () => {
  const res = await POST(post({ origin: 'https://evil.example' }))

  expect(res.status).toBe(403)
  await expect(res.json()).resolves.toEqual({ error: 'forbidden' })
  expect(signOut).not.toHaveBeenCalled()
})

test('a cross-site post is refused on Sec-Fetch-Site alone', async () => {
  // A cross-site form post carries no Origin for `application/x-www-form-urlencoded`
  // in some browsers, but Sec-Fetch-Site still names the relationship.
  for (const site of ['cross-site', 'same-site']) {
    const res = await POST(post({ 'sec-fetch-site': site }))

    expect(res.status, site).toBe(403)
  }
  expect(signOut).not.toHaveBeenCalled()
})

test('Sec-Fetch-Site values our own page produces are allowed', async () => {
  for (const site of ['same-origin', 'none']) {
    const res = await POST(post({ 'sec-fetch-site': site }))

    expect(res.status, site).toBe(303)
  }
})

test('a same-origin post ends the keycloak session, not just ours', async () => {
  // Clearing our own cookie alone leaves Keycloak's SSO cookie alive: on a
  // shared machine the next "sign in" would silently re-authenticate the person
  // who just signed out. RP-initiated logout is the whole point of this route.
  const res = await POST(post({ origin: 'http://localhost:3000' }))

  expect(signOut).toHaveBeenCalledWith({ redirect: false })
  expect(res.status).toBe(303)

  const location = res.headers.get('location')!
  expect(location.startsWith(`${LOGOUT}?`)).toBe(true)
  expect(location).toContain('id_token_hint=idt')
  expect(location).toContain('post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Flogin')
})

test('the id token is read before the session is destroyed', async () => {
  await POST(post())

  // signOut clears the session cookie; reading the JWT afterwards would find
  // nothing, and the realm session would outlive ours.
  expect(getToken.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0])
})

test('the jwt is read from the request cookie, never from the session endpoint', async () => {
  await POST(post())

  expect(getToken).toHaveBeenCalledWith(
    expect.objectContaining({ req: expect.any(Request), secureCookie: false }),
  )
})

test('a __Secure- session cookie selects the secure cookie name', async () => {
  process.env.APP_BASE_URL = 'https://recharacter.us'
  resetEnvForTests()

  await POST(
    new NextRequest('https://recharacter.us/auth/signout', {
      method: 'POST',
      headers: { cookie: '__Secure-authjs.session-token=abc' },
    }),
  )

  expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ secureCookie: true }))
})

test('the cookie name follows the cookie the browser sent, not APP_BASE_URL', async () => {
  // https base URL, but Auth.js issued the plain name (e.g. a proxy rewrote the proto at sign-in).
  process.env.APP_BASE_URL = 'https://recharacter.us'
  resetEnvForTests()
  await POST(
    new NextRequest('https://recharacter.us/auth/signout', {
      method: 'POST',
      headers: { cookie: 'authjs.session-token=abc' },
    }),
  )
  expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ secureCookie: false }))

  // http base URL, but the browser carries the __Secure- (chunked) name.
  process.env.APP_BASE_URL = 'http://localhost:3000'
  resetEnvForTests()
  await POST(
    new NextRequest('http://localhost:3000/auth/signout', {
      method: 'POST',
      headers: { cookie: '__Secure-authjs.session-token.0=a; __Secure-authjs.session-token.1=b' },
    }),
  )
  expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ secureCookie: true }))
})

test('a post with no Origin header (form navigation) is allowed', async () => {
  const res = await POST(post())

  expect(res.status).toBe(303)
  expect(signOut).toHaveBeenCalledWith({ redirect: false })
})

test('without an id token the realm is told which client is logging out', async () => {
  getToken.mockResolvedValue({ sub: 'u' })

  const location = (await POST(post())).headers.get('location')!

  expect(location).toContain('client_id=recharacter-web')
  expect(location).not.toContain('id_token_hint')
})

test('no jwt at all still produces a valid logout redirect', async () => {
  getToken.mockResolvedValue(null)

  const location = (await POST(post())).headers.get('location')!

  expect(location).toContain('client_id=recharacter-web')
  expect(location).not.toContain('id_token_hint')
})

// The attribute, not the `__Secure-` prefix in the name.
const SECURE_ATTR = /;\s*Secure(;|$)/i

/** The Set-Cookie line the response carries for `name`, if any. */
const setCookie = (res: Response, name: string) =>
  res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`))

test('every session cookie the request carried is deleted, chunks included, and nothing else', async () => {
  // Auth.js's own deletion rides on cookies() and loses the race against any
  // response that re-issues the session. This one is the belt to that brace.
  // `Max-Age=0` alone is not enough: Next's appendMutableCookies drops it when
  // it re-parses the headers, leaving an empty-value cookie that displaces
  // Auth.js's own deletion. The past `Expires` is what survives.
  const res = await POST(
    post({
      cookie:
        'authjs.session-token=abc; authjs.session-token.0=def; authjs.session-token.1=ghi; theme=dark; authjs.csrf-token=x',
    }),
  )

  expect(res.status).toBe(303)
  for (const name of ['authjs.session-token', 'authjs.session-token.0', 'authjs.session-token.1']) {
    const line = setCookie(res, name)
    expect(line, name).toMatch(/^[^=]+=;/)
    expect(line, name).toMatch(/Max-Age=0/i)
    expect(line, name).toMatch(/Expires=Thu, 01 Jan 1970/)
    expect(line, name).toMatch(/Path=\//i)
    expect(line, name).toMatch(/HttpOnly/i)
    expect(line, name).not.toMatch(SECURE_ATTR)
  }
  expect(setCookie(res, 'theme')).toBeUndefined()
  expect(setCookie(res, 'authjs.csrf-token')).toBeUndefined()
})

test('the __Secure- session cookie is deleted with the Secure attribute, chunks included', async () => {
  const res = await POST(
    post({
      cookie: '__Secure-authjs.session-token.0=abc; __Secure-authjs.session-token.1=def',
    }),
  )

  for (const name of ['__Secure-authjs.session-token.0', '__Secure-authjs.session-token.1']) {
    const line = setCookie(res, name)
    expect(line, name).toMatch(/^[^=]+=;/)
    expect(line, name).toMatch(/Max-Age=0/i)
    expect(line, name).toMatch(/Expires=Thu, 01 Jan 1970/)
    expect(line, name).toMatch(SECURE_ATTR)
  }
})

test('a request carrying no session cookie emits no Set-Cookie', async () => {
  const res = await POST(post({ cookie: 'theme=dark' }))

  expect(res.status).toBe(303)
  expect(res.headers.getSetCookie()).toEqual([])
})
