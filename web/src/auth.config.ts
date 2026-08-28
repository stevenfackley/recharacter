import type { NextAuthConfig, Session } from 'next-auth'
import { buildAuthConfig } from '@qavren/auth-next'

declare module 'next-auth' {
  interface Session {
    /**
     * Keycloak ID token, kept ONLY to pass `id_token_hint` on RP-initiated
     * logout. Server-side use only — never hand a session object to a client
     * component.
     */
    idToken?: string
  }
}

// `process.env` directly, not `getEnv()`: proxy.ts pulls this module into the
// edge runtime, where env.ts's Buffer-based validation has no business running.
const realm = process.env.QAVREN_REALM || 'recharacter'
const baseUrl = process.env.QAVREN_AUTH_URL || 'https://auth.recharacter.us'

// buildAuthConfig spreads its overrides LAST, so handing it `callbacks` would
// REPLACE the SDK's sub/email/roles callbacks rather than extend them. Take the
// base config and compose the callbacks explicitly.
const base = buildAuthConfig({
  realm,
  baseUrl,
  // Cloudflare Tunnel terminates in front of the app, so the Host header is the
  // public one and Auth.js has to be told to believe it. AUTH_SECRET is read by
  // Auth.js itself.
  trustHost: true,
  pages: { signIn: '/login' },
})

/**
 * The composed Auth.js config, kept apart from `auth.ts` so it can be imported
 * (and unit-tested) without loading NextAuth's server runtime — the same split
 * @qavren/auth-next makes between its own config.ts and index.ts.
 */
export const authConfig: NextAuthConfig = {
  ...base,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  callbacks: {
    ...base.callbacks,
    async jwt(params) {
      const token = (await base.callbacks!.jwt!(params)) ?? params.token
      // Only present on the sign-in call; later invocations carry it forward on
      // the existing token.
      if (params.account?.id_token) token.idToken = params.account.id_token
      return token
    },
    async session(params) {
      // The core `session` callback is typed `Awaitable<Session | DefaultSession>`
      // because it also serves the database strategy. We run `strategy: 'jwt'`,
      // where the value passed through is our augmented `Session`; narrow to it
      // rather than loosening `strict`.
      const session = (await base.callbacks!.session!(params)) as Session
      // `session.user.id` is the Keycloak `sub` — it becomes `owner_id`
      // everywhere in the app, so it must never fall back to email or name.
      if (session.user && params.token.sub) session.user.id = params.token.sub
      session.idToken = typeof params.token.idToken === 'string' ? params.token.idToken : undefined
      return session
    },
  },
}
