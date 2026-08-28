import { expect, test } from 'vitest'
import { buildAuthConfig } from '@qavren/auth-next'
import type { Session } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import { authConfig } from './auth.config'

const SUB = '11111111-2222-4333-8444-555555555555'

// The `session` callback's parameter type is the union of the jwt- and
// database-strategy shapes, so it demands adapter fields we never see under
// `strategy: 'jwt'`. Build the jwt-strategy half and cast once, here.
type SessionParams = Parameters<NonNullable<NonNullable<typeof authConfig.callbacks>['session']>>[0]

const sessionParams = (session: Partial<Session>, token: Partial<JWT>) =>
  ({ session, token, newSession: undefined }) as unknown as SessionParams

test('the SDK wires the realm as a public keycloak client', () => {
  // Auth.js keeps caller-supplied provider settings under `options`.
  const provider = buildAuthConfig({ realm: 'recharacter' }).providers[0] as {
    id: string
    options: { clientId: string; clientSecret?: string; client: Record<string, unknown> }
  }

  expect(provider.id).toBe('keycloak')
  expect(provider.options.clientId).toBe('recharacter-web')
  // A public client: PKCE plus the realm's redirect allow-list, no secret.
  expect(provider.options.clientSecret).toBeUndefined()
  expect(provider.options.client).toMatchObject({ token_endpoint_auth_method: 'none' })
})

test('our config points at the recharacter realm and a week-long jwt session', () => {
  expect(authConfig.providers[0]).toMatchObject({
    id: 'keycloak',
    options: {
      clientId: 'recharacter-web',
      issuer: 'https://auth.recharacter.us/realms/recharacter',
    },
  })
  expect(authConfig.session).toEqual({ strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 })
  expect(authConfig.trustHost).toBe(true)
  expect(authConfig.pages).toEqual({ signIn: '/login' })
})

test('the jwt callback keeps the sdk behaviour and stashes the id token', async () => {
  const token = await authConfig.callbacks!.jwt!({
    token: {} as JWT,
    user: { id: SUB },
    account: {
      provider: 'keycloak',
      providerAccountId: SUB,
      type: 'oidc',
      id_token: 'idt',
    },
    profile: { sub: SUB, email: 'vet@example.test' },
  })

  // SDK behaviour survives composition.
  expect(token!.sub).toBe(SUB)
  expect(token!.email).toBe('vet@example.test')
  expect(token!.roles).toEqual([])
  // Ours.
  expect(token!.idToken).toBe('idt')
})

test('the session callback takes user.id from the keycloak sub', async () => {
  const session = (await authConfig.callbacks!.session!(
    sessionParams(
      { user: { email: 'vet@example.test', roles: [] }, expires: '' },
      { sub: SUB, roles: ['veteran'], idToken: 'idt' },
    ),
  )) as Session

  expect(session.user!.id).toBe(SUB)
  expect(session.user!.roles).toEqual(['veteran'])
  expect(session.idToken).toBe('idt')
})

test('a token without an id token leaves the session hint unset', async () => {
  const session = (await authConfig.callbacks!.session!(
    sessionParams({ user: { email: null, roles: [] }, expires: '' }, { sub: SUB }),
  )) as Session

  expect(session.idToken).toBeUndefined()
})
