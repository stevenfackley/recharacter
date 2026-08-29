import { describe, expect, test } from 'vitest'
import { AUTH_ERRORS, authErrorMessage } from './auth-errors'

// Error text never travels in a URL: `?error=<free text>` rendered on the real
// domain is a phishing surface. Only these closed-enum codes cross the wire,
// and only their own copy is ever shown.
describe('authErrorMessage', () => {
  test('a known code maps to its own copy', () => {
    expect(authErrorMessage('signin_failed')).toBe(AUTH_ERRORS.signin_failed)
    expect(authErrorMessage('session_expired')).toBe(AUTH_ERRORS.session_expired)
    expect(authErrorMessage('deletion_unavailable')).toBe(AUTH_ERRORS.deletion_unavailable)
  })

  test('an unknown code yields nothing to render', () => {
    expect(authErrorMessage('Your bank needs your password')).toBeNull()
    expect(authErrorMessage('')).toBeNull()
  })

  test('inherited object keys are not codes', () => {
    // `'constructor' in AUTH_ERRORS` is true; Object.hasOwn is the check that holds.
    expect(authErrorMessage('constructor')).toBeNull()
    expect(authErrorMessage('toString')).toBeNull()
    expect(authErrorMessage('__proto__')).toBeNull()
  })

  test('non-strings yield nothing', () => {
    expect(authErrorMessage(undefined)).toBeNull()
    expect(authErrorMessage(null)).toBeNull()
    expect(authErrorMessage(['signin_failed'])).toBeNull()
  })
})
