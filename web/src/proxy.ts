import { NextResponse } from 'next/server'
import { auth } from '@/auth'

// Exact segment prefixes — `/casework` is not `/case`.
const PROTECTED = ['/case', '/settings', '/api/ai', '/api/packet', '/api/account']

// Next 16 convention: proxy.ts replaces the deprecated middleware.ts, and the
// file exports exactly one handler — named `proxy` here, which is the form the
// Next 16 docs show first. `auth()` resolves the session onto `req.auth`.
export const proxy = auth((req) => {
  const { pathname, search } = req.nextUrl
  const needsAuth = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'))
  if (!needsAuth || req.auth?.user?.id) return NextResponse.next()

  // API callers get a status they can act on; a 307 to an HTML login page would
  // reach them as an unparseable body.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const login = new URL('/login', req.nextUrl.origin)
  login.searchParams.set('next', pathname + search)
  return NextResponse.redirect(login)
})

export const config = {
  // Skip static assets, Auth.js's own routes, the health probe (container
  // liveness must not depend on the auth provider being reachable), and
  // anything with a file extension.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/health|.*\\..*).*)'],
}
