import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The sign-in hand-off. `safeNext` is the real one: what matters is the value
 * that reaches Auth.js as `redirectTo`, and a `next` field is attacker-supplied
 * by definition (an open redirect off a sign-in page is a phishing chain).
 */

const signIn = vi.fn()
vi.mock('@/auth', () => ({ signIn, auth: vi.fn() }))

const { loginAction } = await import('./actions')

function form(next?: string) {
  const fd = new FormData()
  if (next !== undefined) fd.set('next', next)
  return fd
}

beforeEach(() => {
  signIn.mockReset()
})

describe('loginAction', () => {
  test('hands off to the keycloak provider carrying the return-to path', async () => {
    await loginAction(form('/case/nexus?x=1'))

    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith('keycloak', { redirectTo: '/case/nexus?x=1' })
  })

  test('no next field lands on /case', async () => {
    await loginAction(form())

    expect(signIn).toHaveBeenCalledWith('keycloak', { redirectTo: '/case' })
  })

  test('an off-site next is neutralised to /case', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'case']) {
      signIn.mockReset()
      await loginAction(form(bad))
      expect(signIn, bad).toHaveBeenCalledWith('keycloak', { redirectTo: '/case' })
    }
  })

  test('sends no authorization hint: plain sign-in opens the login form, not registration', async () => {
    await loginAction(form('/case'))

    // The signup action differs from this one ONLY by its third argument.
    expect(signIn.mock.calls[0]).toHaveLength(2)
  })
})
