import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const PROTECTED = ['/case']

// Next 16 convention: proxy.ts replaces the deprecated middleware.ts.
export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)

  const needsAuth = PROTECTED.some((p) => request.nextUrl.pathname.startsWith(p))
  if (needsAuth && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
