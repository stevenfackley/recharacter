import Link from 'next/link'
import type { Metadata } from 'next'
import { requireSessionUser } from '@/lib/session'
import { getEnv } from '@/lib/env'
import { isEntitled, hasPaidEntitlement } from '@/lib/billing'
import { verifySession } from '@/lib/billing-verify'
import { startCheckout, restorePurchaseAction } from './actions'

export const metadata: Metadata = { title: 'Unlock your case' }

/** Closed set: only these codes resolve to copy, never `params.error` itself. */
const ERRORS = {
  checkout_failed: 'Could not start checkout — try again shortly.',
  not_configured: 'Payments are not yet configured — you can still unlock with your own API key.',
  verify_failed:
    'We could not confirm that payment. If you were charged, press “Restore a previous purchase”.',
} as const

/**
 * The freemium boundary, explained and unlocked (design spec §10). Two paths to the
 * same entitlement: a one-time paid unlock, or a BYOK key (the veteran already bears
 * the AI cost, so charging again would be double-dipping).
 */
export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const user = await requireSessionUser('/case/upgrade')

  let entitled = await isEntitled(user.id)

  // Redirect-verification: a `?session_id=` from Stripe's success_url is checked
  // server-side (payment_status + client_reference_id) before anything is
  // granted. Stripe returns by GET, so this is the only place it can happen —
  // but an already-unlocked veteran needs no Stripe round-trip at all.
  let verifyFailed = false
  if (!entitled && params.session_id) {
    entitled = await verifySession(user.id, params.session_id)
    verifyFailed = !entitled
  }

  // A veteran who paid is thanked for paying even if they also brought a key;
  // only an unpaid account is told the key is what unlocked it.
  const paid = entitled && (await hasPaidEntitlement(user.id))
  const stripeConfigured = Boolean(getEnv().STRIPE_SECRET_KEY)
  const error = verifyFailed
    ? ERRORS.verify_failed
    : ERRORS[params.error as keyof typeof ERRORS] ?? null

  return (
    <main>
      <h1>Unlock AI drafting and your filing packet</h1>

      {error && <p role="alert">{error}</p>}
      {params.canceled === '1' && (
        <p role="alert">Checkout was canceled — you were not charged.</p>
      )}

      <section>
        <h2>Always free</h2>
        <p>
          Intake, eligibility, routing, your evidence checklist, and education never cost
          anything — you can reach a complete, personalized action plan at $0.
        </p>
      </section>

      <section>
        <h2>What unlocking adds</h2>
        <p>
          AI-assisted phrasing help on your four answers, your personal statement and cover
          letter drafts, and packet assembly for download.
        </p>
      </section>

      {entitled ? (
        <section>
          <p role="status">
            {paid
              ? 'Your case is unlocked — thank you.'
              : 'Your case is unlocked through your own API key.'}
          </p>
        </section>
      ) : (
        <>
          <section>
            <h2>Option 1 — one-time unlock</h2>
            {stripeConfigured ? (
              <form action={startCheckout}>
                <button type="submit">Unlock with a one-time payment</button>
              </form>
            ) : (
              <p>Payments are not yet configured — use your own API key below instead.</p>
            )}
            <form action={restorePurchaseAction}>
              <button type="submit">Restore a previous purchase</button>
            </form>
          </section>

          <section>
            <h2>Option 2 — bring your own API key</h2>
            <p>
              Already have an Anthropic API key? Add it in{' '}
              <Link href="/settings/ai">AI settings</Link> and everything unlocks at no
              additional charge — you already bear the AI cost.
            </p>
          </section>
        </>
      )}

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
