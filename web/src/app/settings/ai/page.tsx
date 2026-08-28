import Link from 'next/link'
import type { Metadata } from 'next'
import { requireSessionUser } from '@/lib/session'
import { credentialCreatedAt } from '@/lib/ai/credentials'
import { usageTotals } from '@/lib/ai/usage'
import { saveByokKey, removeByokKey } from './actions'

export const metadata: Metadata = { title: 'AI settings' }

/** Closed set: only these codes resolve to copy, never `params.error` itself. */
const ERRORS = {
  invalid_key: 'Enter your API key.',
  save_failed: 'Could not save your key — try again shortly.',
  remove_failed: 'Could not remove your key — try again shortly.',
  kek_missing: 'Saved keys are unavailable right now. Nothing was stored; try again later.',
} as const

export default async function AiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const user = await requireSessionUser('/settings/ai')

  // Existence and age only — the stored key is ciphertext and never leaves the server.
  const savedAt = await credentialCreatedAt(user.id)
  // Summed in Postgres: paging every usage row into JS to add two columns is a
  // query that gets slower for the veterans who use the product most.
  const totals = await usageTotals(user.id)

  const error = ERRORS[params.error as keyof typeof ERRORS] ?? null

  return (
    <main>
      <h1>AI settings</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Your own API key (BYOK)</h2>
        {savedAt ? (
          <>
            <p>
              A key is saved (encrypted) since {savedAt.toLocaleDateString()}. AI requests bill
              your own Anthropic account.
            </p>
            <form action={removeByokKey}>
              <button type="submit">Remove my key</button>
            </form>
          </>
        ) : (
          <>
            <p>No key saved — the managed tier is in use.</p>
            <form action={saveByokKey}>
              <input name="apiKey" type="password" placeholder="sk-ant-..." required />
              <button type="submit">Save key</button>
            </form>
          </>
        )}
      </section>

      <section>
        <h2>Usage</h2>
        <p>
          {totals.inputTokens.toLocaleString()} input / {totals.outputTokens.toLocaleString()} output
          tokens over {totals.calls.toLocaleString()} request{totals.calls === 1 ? '' : 's'}
        </p>
      </section>

      <p><Link href="/settings/data">Your data — export or delete everything</Link></p>
    </main>
  )
}
