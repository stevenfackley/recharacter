import { login } from './actions'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Sign in</h1>
      {error && <p role="alert">{error}</p>}
      <form action={login}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
      <a href="/signup">Create an account</a>
    </main>
  )
}
