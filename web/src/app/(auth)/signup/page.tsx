import { signup } from './actions'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Create your account' }

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Create your account</h1>
      {error && <p role="alert">{error}</p>}
      <form action={signup}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Create account</button>
      </form>
      <a href="/login">I already have an account</a>
    </main>
  )
}
