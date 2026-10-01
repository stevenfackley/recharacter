import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import type { NextAuthRequest } from 'next-auth'
import { auth } from '@/auth'
import { stripSessionRefresh } from '@/lib/session-cookies'

// Exact segment prefixes — `/casework` is not `/case`.
const PROTECTED = ['/case', '/settings', '/api/ai', '/api/packet', '/api/account']

// `auth()` resolves the session onto `req.auth`.
//
// This is a redirect convenience, not the authorization boundary: every
// protected handler and page calls `getSessionUser()` itself and enforces
// ownership there. Nothing may rely on the proxy having run.
//
// Typed as the (request, event) middleware signature so `auth()` resolves to its
// middleware overload, which hands back a callable `(req, event)` rather than a
// route handler wanting a `params` context.
const guard: (req: NextAuthRequest, event: NextFetchEvent) => Response = (req) => {
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
}
const gate = auth(guard)

// Next 16 convention: proxy.ts replaces the deprecated middleware.ts, and the
// file exports exactly one handler — named `proxy` here, which is the form the
// Next 16 docs show first.
export async function proxy(req: NextRequest, event: NextFetchEvent) {
  // The sign-out route deletes the session cookie. The Auth.js wrapper would
  // append a refreshed one to that same response, and the browser's header order
  // decides who wins — so the route never goes through the wrapper.
  if (req.nextUrl.pathname === '/auth/signout') return NextResponse.next()

  // The wrapper appends a refreshed session cookie to every response it wraps;
  // never let that reach the browser (see stripSessionRefresh). Sessions are
  // therefore a fixed `maxAge`, not sliding.
  return stripSessionRefresh(await gate(req, event))
}

export const config = {
  // Skip Next's build output, Auth.js's own routes, the health probe (container
  // liveness must not depend on the auth provider being reachable), and static
  // files — matched by an anchored list of asset extensions, not by "contains a
  // dot", which would silently unguard real routes like /api/ai/extract.v2.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|api/auth|api/health|.*\\.(?:ico|png|svg|jpg|jpeg|gif|webp|css|js|map|woff2?|ttf|txt|xml|webmanifest)$).*)',
  ],
}
