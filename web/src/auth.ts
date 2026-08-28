import NextAuth from 'next-auth'
import { authConfig } from './auth.config'

// Node-only imports are banned in this module and everything it pulls in:
// proxy.ts imports `auth`, so this graph runs in the edge runtime.
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
export { authConfig }
