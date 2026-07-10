import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { startCheckout, restorePurchaseAction, verifySession } from './actions'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Unlock your case' }

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

  // Redirect-verification: a `?session_id=` from Stripe's success_url is checked
  // server-side (payment_status + client_reference_id) before anything is granted.
  if (params.session_id) {
    await verifySession(params.session_id)
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let paid = false
  let byok = false
  if (user) {
    const [{ data: entitlement }, { data: credential }] = await Promise.all([
      supabase.from('entitlements').select('id').eq('owner_id', user.id).maybeSingle(),
      supabase.from('ai_credentials').select('owner_id').eq('owner_id', user.id).maybeSingle(),
    ])
    paid = Boolean(entitlement)
    byok = Boolean(credential)
  }
  const unlocked = paid || byok
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY)

  return (
    <main>
      <h1>Unlock AI drafting and your filing packet</h1>

      {params.error && <p role="alert">{params.error}</p>}
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

      {unlocked ? (
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
