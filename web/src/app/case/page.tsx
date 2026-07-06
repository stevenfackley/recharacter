import { getOrCreateCase } from '@/lib/cases'

const STEPS = ['Intake', 'Routing', 'Evidence', 'Nexus', 'Draft', 'Coaching', 'Packet'] as const

export default async function CasePage() {
  const c = await getOrCreateCase()
  return (
    <main>
      <h1>Your discharge-upgrade case</h1>
      <p>Case ID: {c.id}</p>
      <ol>
        {STEPS.map((step) => (
          <li key={step}>{step} — not started</li>
        ))}
      </ol>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
