import NextAuth from 'next-auth'
import { authConfig } from './auth.config'

// proxy.ts imports `auth`, so keep this module's import graph free of the DB
// client and anything else a request-path module has no business dragging in.
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
export { authConfig }
