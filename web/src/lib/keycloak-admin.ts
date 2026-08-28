import { getEnv } from '@/lib/env'

export class KeycloakAdminUnavailable extends Error {}

type Fetch = typeof fetch

export type KeycloakAdmin = {
  /** Proves configuration + credentials BEFORE any data is deleted. */
  getToken(): Promise<string>
  /** 204/200 → deleted; 404 → treated as already deleted (logged loudly); anything else throws. */
  deleteUser(sub: string, token: string): Promise<void>
}

export function keycloakAdminConfigured(): boolean {
  return Boolean(getEnv().QAVREN_ADMIN_CLIENT_SECRET)
}

export function createKeycloakAdmin(fetchImpl: Fetch = fetch): KeycloakAdmin {
  const env = getEnv()
  if (!env.QAVREN_ADMIN_CLIENT_SECRET) {
    throw new KeycloakAdminUnavailable('QAVREN_ADMIN_CLIENT_SECRET is not set; account deletion is disabled')
  }
  const base = (env.KEYCLOAK_ADMIN_BASE_URL ?? env.QAVREN_AUTH_URL).replace(/\/+$/, '')
  const realm = env.QAVREN_REALM
  const clientId = env.QAVREN_ADMIN_CLIENT_ID
  const clientSecret = env.QAVREN_ADMIN_CLIENT_SECRET

  return {
    async getToken() {
      const res = await fetchImpl(`${base}/realms/${realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status !== 200) throw new Error(`keycloak token endpoint returned ${res.status}`)
      const json = (await res.json()) as { access_token?: string }
      if (!json.access_token) throw new Error('keycloak token response had no access_token')
      return json.access_token
    },
    async deleteUser(sub, token) {
      if (!sub || !sub.trim()) throw new Error('keycloak deleteUser called without a sub')
      const res = await fetchImpl(`${base}/admin/realms/${realm}/users/${encodeURIComponent(sub)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 204 || res.status === 200) return
      if (res.status === 404) {
        // A wrong realm/base URL ALSO 404s on every call — never let this be silent.
        console.error(`keycloak user ${sub} not found in realm ${realm} at ${base}; treating as already deleted`)
        return
      }
      throw new Error(`keycloak user delete returned ${res.status}`)
    },
  }
}
