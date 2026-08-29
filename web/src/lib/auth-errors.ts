/**
 * The complete set of auth failures the app is willing to name in a URL.
 *
 * Only these keys ever appear as `?error=`; the copy lives here and is looked
 * up on render. Echoing an arbitrary `?error=` string back onto recharacter.us
 * would let anyone put their own words on our page — a phishing surface on a
 * product whose users are already being asked for stigmatizing records.
 */
export const AUTH_ERRORS = {
  signin_failed: 'Sign-in did not complete. Please try again.',
  session_expired: 'Your session expired. Sign in again to continue.',
  deletion_unavailable: 'Account deletion is temporarily unavailable. Nothing was removed.',
} as const

export type AuthErrorCode = keyof typeof AUTH_ERRORS

/** Copy for a known code, or `null` — never the caller's own string. */
export function authErrorMessage(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(AUTH_ERRORS, code)
    ? AUTH_ERRORS[code as AuthErrorCode]
    : null
}
