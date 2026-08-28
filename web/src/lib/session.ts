import { redirect } from 'next/navigation'
import { auth } from '@/auth'

export type SessionUser = { id: string; email: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The one place session identity is read. `id` is the Keycloak `sub`, and it is
 * the `owner_id` on every row the user owns — so a non-UUID id is treated as no
 * session rather than passed downstream.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth()
  const id = session?.user?.id
  if (!id || !UUID.test(id)) return null
  return { id, email: session!.user!.email ?? null }
}

/** Pages/actions: redirect to login (with return-to) when unauthenticated. */
export async function requireSessionUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  return user
}

/**
 * Only same-origin, absolute-path targets survive; anything else goes to /case.
 * A `next` parameter is attacker-supplied by definition — an open redirect off
 * a sign-in page is how a convincing credential-phishing chain starts.
 */
export function safeNext(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
    ? value
    : '/case'
}
