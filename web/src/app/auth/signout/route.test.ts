import { beforeEach, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'

const auth = vi.fn()
const signOut = vi.fn()

vi.mock('@/auth', () => ({ auth, signOut }))

const { POST } = await import('./route')

const LOGOUT = 'https://auth.recharacter.us/realms/recharacter/protocol/openid-connect/logout'

beforeEach(() => {
  auth.mockReset()
  signOut.mockReset()
  auth.mockResolvedValue({ user: { id: 'u' }, idToken: 'idt' })
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

test('a post with no Origin header (form navigation) is allowed', async () => {
  const res = await POST(post())

  expect(res.status).toBe(303)
  expect(signOut).toHaveBeenCalledWith({ redirect: false })
})

test('without an id token the realm is told which client is logging out', async () => {
  auth.mockResolvedValue({ user: { id: 'u' } })

  const location = (await POST(post())).headers.get('location')!

  expect(location).toContain('client_id=recharacter-web')
  expect(location).not.toContain('id_token_hint')
})
