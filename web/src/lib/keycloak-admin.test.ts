import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'
import {
  createKeycloakAdmin,
  keycloakAdminConfigured,
  KeycloakAdminUnavailable,
} from '@/lib/keycloak-admin'

const TOUCHED = [
  'QAVREN_AUTH_URL',
  'QAVREN_REALM',
  'QAVREN_ADMIN_CLIENT_ID',
  'QAVREN_ADMIN_CLIENT_SECRET',
  'KEYCLOAK_ADMIN_BASE_URL',
] as const
const saved: Partial<Record<(typeof TOUCHED)[number], string | undefined>> = {}

const SECRET = 'super-secret-value-do-not-log'

describe('keycloak-admin', () => {
  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k]
    for (const k of TOUCHED) delete process.env[k]
    resetEnvForTests()
  })
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetEnvForTests()
    vi.restoreAllMocks()
  })

  describe('configuration gate', () => {
    it('keycloakAdminConfigured is false without a secret', () => {
      expect(keycloakAdminConfigured()).toBe(false)
    })

    it('keycloakAdminConfigured is true once the secret is set', () => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      resetEnvForTests()
      expect(keycloakAdminConfigured()).toBe(true)
    })

    it('createKeycloakAdmin throws KeycloakAdminUnavailable without a secret', () => {
      expect(() => createKeycloakAdmin(vi.fn())).toThrow(KeycloakAdminUnavailable)
    })
  })

  describe('getToken', () => {
    beforeEach(() => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      resetEnvForTests()
    })

    it('POSTs to the token endpoint with redirect: manual and the client credentials body', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 }),
      )
      const admin = createKeycloakAdmin(fetchImpl)
      const token = await admin.getToken()

      expect(token).toBe('tok-123')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('https://auth.recharacter.us/realms/recharacter/protocol/openid-connect/token')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      const body = init?.body as URLSearchParams
      const bodyStr = body.toString()
      expect(bodyStr).toContain('grant_type=client_credentials')
      expect(bodyStr).toContain('client_id=recharacter-admin-svc')
      expect(bodyStr).toContain(encodeURIComponent(SECRET))
    })

    it('throws on a 302 redirect instead of following it', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.getToken()).rejects.toThrow()
    })

    it('throws on 401', async () => {
      const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.getToken()).rejects.toThrow()
    })

    it('throws on a 200 body missing access_token', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.getToken()).rejects.toThrow()
    })
  })

  describe('deleteUser', () => {
    beforeEach(() => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      resetEnvForTests()
    })

    it('calls DELETE on the encoded user path with a bearer token, resolves on 204', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.deleteUser('abc def', 't')).resolves.toBeUndefined()

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('https://auth.recharacter.us/admin/realms/recharacter/users/abc%20def')
      expect(init?.method).toBe('DELETE')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t')
      expect(init?.redirect).toBe('manual')
    })

    it('resolves on 200', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.deleteUser('abc', 't')).resolves.toBeUndefined()
    })

    it('resolves and logs at error level on 404, naming the sub and realm', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.deleteUser('missing-sub', 't')).resolves.toBeUndefined()

      expect(errorSpy).toHaveBeenCalledTimes(1)
      const message = errorSpy.mock.calls[0].join(' ')
      expect(message).toContain('missing-sub')
      expect(message).toContain('recharacter')
    })

    it('throws on 403', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.deleteUser('abc', 't')).rejects.toThrow()
    })

    it('throws on 500', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await expect(admin.deleteUser('abc', 't')).rejects.toThrow()
    })
  })

  describe('KEYCLOAK_ADMIN_BASE_URL override', () => {
    it('uses the override, stripped of a trailing slash, for both endpoints', async () => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      process.env.KEYCLOAK_ADMIN_BASE_URL = 'https://admin.example.test/'
      resetEnvForTests()

      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }),
      )
      const admin = createKeycloakAdmin(fetchImpl)
      await admin.getToken()
      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://admin.example.test/realms/recharacter/protocol/openid-connect/token',
      )

      const deleteFetch = vi.fn(async () => new Response(null, { status: 204 }))
      const admin2 = createKeycloakAdmin(deleteFetch)
      await admin2.deleteUser('abc', 't')
      expect(deleteFetch.mock.calls[0][0]).toBe(
        'https://admin.example.test/admin/realms/recharacter/users/abc',
      )
    })

    it('falls back to QAVREN_AUTH_URL when no override is set', async () => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      resetEnvForTests()

      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }),
      )
      const admin = createKeycloakAdmin(fetchImpl)
      await admin.getToken()
      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://auth.recharacter.us/realms/recharacter/protocol/openid-connect/token',
      )
    })
  })

  describe('secret never logged', () => {
    it('the 404 console.error call never contains the client secret', async () => {
      process.env.QAVREN_ADMIN_CLIENT_SECRET = SECRET
      resetEnvForTests()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
      const admin = createKeycloakAdmin(fetchImpl)
      await admin.deleteUser('abc', 't')

      for (const call of errorSpy.mock.calls) {
        const joined = call.join(' ')
        expect(joined).not.toContain(SECRET)
      }
    })
  })
})
