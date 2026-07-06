import { expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Force "no user" from the refresh helper so we exercise the guard branch.
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: async (request: NextRequest) => ({
    response: (await import('next/server')).NextResponse.next({ request }),
    user: null,
  }),
}))

test('unauthenticated request to /case is redirected to /login', async () => {
  const { proxy } = await import('@/proxy')
  const res = await proxy(new NextRequest('http://localhost/case'))

  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toContain('/login')
})

test('unauthenticated request to a public route is not redirected', async () => {
  const { proxy } = await import('@/proxy')
  const res = await proxy(new NextRequest('http://localhost/login'))

  expect(res.status).toBe(200)
})
