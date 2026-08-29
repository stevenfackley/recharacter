import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Registration is the SAME authorization request as sign-in plus the OIDC
 * `prompt=create` hint — there is no separate endpoint. That hint is the entire
 * reason this action exists, so it is pinned verbatim.
 */

const signIn = vi.fn()
vi.mock('@/auth', () => ({ signIn, auth: vi.fn() }))

const { signupAction } = await import('./actions')

function form(next?: string) {
  const fd = new FormData()
  if (next !== undefined) fd.set('next', next)
  return fd
}

beforeEach(() => {
  signIn.mockReset()
})

describe('signupAction', () => {
  test('hands off to keycloak with the return-to path AND the prompt=create hint', async () => {
    await signupAction(form('/case/nexus?x=1'))

    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith(
      'keycloak',
      { redirectTo: '/case/nexus?x=1' },
      { prompt: 'create' },
    )
  })

  test('the authorization params are exactly { prompt: "create" } — nothing else rides along', async () => {
    await signupAction(form('/case'))

    expect(signIn.mock.calls[0][2]).toEqual({ prompt: 'create' })
  })

  test('no next field lands on /case', async () => {
    await signupAction(form())

    expect(signIn).toHaveBeenCalledWith('keycloak', { redirectTo: '/case' }, { prompt: 'create' })
  })

  test('an off-site next is neutralised to /case', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'case']) {
      signIn.mockReset()
      await signupAction(form(bad))
      expect(signIn, bad).toHaveBeenCalledWith('keycloak', { redirectTo: '/case' }, { prompt: 'create' })
    }
  })
})
