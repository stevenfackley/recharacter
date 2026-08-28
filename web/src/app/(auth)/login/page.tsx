import type { Metadata } from 'next'
import { loginAction } from './actions'
import { authErrorMessage } from '@/lib/auth-errors'
import { safeNext } from '@/lib/session'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>
}) {
  const params = await searchParams
  // Only our own closed set of codes is ever rendered — never `params.error`
  // itself. Free text from a URL, shown on recharacter.us, is a phishing tool.
  const message = authErrorMessage(params.error)

  return (
    <main>
      <h1>Sign in</h1>
      {message && <p role="alert">{message}</p>}
      <p>
        Sign-in happens on the ReCharacter sign-in service at{' '}
        <strong>auth.recharacter.us</strong>. The address bar will change to that
        name while you enter your password, then bring you back here.
      </p>
      <form action={loginAction}>
        <input type="hidden" name="next" value={safeNext(params.next)} />
        <button type="submit">Sign in</button>
      </form>
      <p>Forgot your password? You can reset it on the sign-in screen.</p>
      <a href="/signup">Create an account</a>
    </main>
  )
}
