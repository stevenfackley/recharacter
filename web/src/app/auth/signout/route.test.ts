import { beforeEach, expect, test, vi } from 'vitest'
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
  return new Request('http://localhost:3000/auth/signout', { method: 'POST', headers })
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

test('over https the secure cookie prefix is used', async () => {
  process.env.APP_BASE_URL = 'https://recharacter.us'
  resetEnvForTests()

  await POST(new Request('https://recharacter.us/auth/signout', { method: 'POST' }))

  expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ secureCookie: true }))
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
