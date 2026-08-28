import { expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

// `auth(handler)` wraps the handler with session resolution. Unwrap it here so
// the guard itself is under test; the session is supplied per case as `req.auth`.
vi.mock('@/auth', () => ({
  auth: (handler: unknown) => handler,
}))

const { proxy, config } = await import('@/proxy')

const SUB = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

type AuthedRequest = NextRequest & { auth: { user?: { id?: string } } | null }

function request(url: string, session: { user?: { id?: string } } | null = null) {
  const req = new NextRequest(url) as AuthedRequest
  req.auth = session
  return req
}

// The proxy is typed as Auth.js middleware; call it as the plain function it is.
const run = (req: NextRequest) => (proxy as unknown as (r: NextRequest) => Response)(req)

test('an unauthenticated page request redirects to login carrying the return-to', async () => {
  const res = await run(request('http://localhost:3000/case/nexus?x=1'))

  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toBe(
    'http://localhost:3000/login?next=%2Fcase%2Fnexus%3Fx%3D1',
  )
})

test('an unauthenticated API request gets 401 JSON, not an HTML redirect', async () => {
  const res = await run(request('http://localhost:3000/api/packet'))

  expect(res.status).toBe(401)
  await expect(res.json()).resolves.toEqual({ error: 'unauthenticated' })
})

test('a signed-in request passes through', async () => {
  const res = await run(request('http://localhost:3000/case', { user: { id: SUB } }))

  expect(res.status).toBe(200)
  expect(res.headers.get('location')).toBeNull()
})

test('public routes never require a session', async () => {
  for (const path of ['/', '/privacy', '/terms', '/login', '/signup']) {
    const res = await run(request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(200)
  }
})

test('a path that merely starts with a protected prefix is not protected', async () => {
  // /casework must not be swallowed by the /case guard.
  for (const path of ['/casework', '/settings-help', '/api/aircraft']) {
    const res = await run(request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(200)
  }
})

test('every protected page prefix redirects, at the root and below', async () => {
  for (const path of ['/case', '/case/intake', '/settings', '/settings/ai']) {
    const res = await run(request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(307)
    expect(res.headers.get('location'), path).toContain('/login?next=')
  }
})

test('every protected api prefix answers 401, at the root and below', async () => {
  for (const path of ['/api/ai', '/api/ai/draft', '/api/packet', '/api/account/export']) {
    const res = await run(request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(401)
    expect(res.headers.get('location'), path).toBeNull()
  }
})

test('a session without a user id is not a session', async () => {
  const res = await run(request('http://localhost:3000/case', { user: {} }))

  expect(res.status).toBe(307)
})

test('the matcher skips static assets, the health probe and auth.js own routes', async () => {
  const [pattern] = config.matcher
  const matcher = new RegExp(`^${pattern}$`)

  // Container liveness must not depend on the auth provider being reachable.
  expect(matcher.test('/api/health')).toBe(false)
  expect(matcher.test('/api/auth/callback/keycloak')).toBe(false)
  expect(matcher.test('/api/auth/session')).toBe(false)
  expect(matcher.test('/_next/static/chunk.js')).toBe(false)
  expect(matcher.test('/favicon.ico')).toBe(false)
  expect(matcher.test('/logo.svg')).toBe(false)
  expect(matcher.test('/file.svg')).toBe(false)
  // Still catches what it is meant to guard.
  expect(matcher.test('/case')).toBe(true)
  expect(matcher.test('/api/packet')).toBe(true)
})

test('a dot in a protected path does not exempt it from the matcher', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`)

  // An extension allow-list, not "contains a dot": a versioned route segment or
  // a case id with a period must stay guarded. Excluding every dotted path is
  // how a protected route silently loses its guard.
  expect(matcher.test('/api/ai/extract.v2')).toBe(true)
  expect(matcher.test('/case/foo.bar')).toBe(true)
})
