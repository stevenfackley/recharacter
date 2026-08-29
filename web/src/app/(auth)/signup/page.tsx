import type { Metadata } from 'next'
import { signupAction } from './actions'
import { authErrorMessage } from '@/lib/auth-errors'
import { safeNext } from '@/lib/session'

export const metadata: Metadata = { title: 'Create your account' }

export default async function SignupPage({
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
      <h1>Create your account</h1>
      {message && <p role="alert">{message}</p>}
      <p>
        Accounts are created on the ReCharacter sign-in service at{' '}
        <strong>auth.recharacter.us</strong>. The address bar will change to that
        name while you choose an email and password, then bring you back here.
      </p>
      <form action={signupAction}>
        <input type="hidden" name="next" value={safeNext(params.next)} />
        <button type="submit">Create your account</button>
      </form>
      <a href="/login">I already have an account</a>
    </main>
  )
}
