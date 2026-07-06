'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'
import { recordPendingCheckout, grantEntitlement } from '@/lib/billing'

const UNCONFIGURED_ERROR = 'Payments are not yet configured — you can still unlock with your own API key'

/** Null when Stripe isn't configured — the friendly "not yet configured" path, never a crash. */
function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key)
}

/** Starts hosted Stripe Checkout for the one-time case unlock. */
export async function startCheckout() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const stripe = getStripeClient()
  const priceId = process.env.STRIPE_PRICE_ID
  const baseUrl = process.env.APP_BASE_URL
  if (!stripe || !priceId || !baseUrl) {
    redirect('/case/upgrade?error=' + encodeURIComponent(UNCONFIGURED_ERROR))
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    success_url: `${baseUrl}/case/upgrade?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/case/upgrade?canceled=1`,
  })

  await recordPendingCheckout(session.id)

  if (!session.url) {
    redirect('/case/upgrade?error=' + encodeURIComponent('Could not start checkout — try again shortly'))
  }
  redirect(session.url)
}

/**
 * The security-critical check: a session grants an entitlement ONLY when Stripe
 * confirms it was actually paid AND it was created for THIS signed-in user
 * (client_reference_id) — otherwise a session id leaked via a shared link or a
 * server log could be replayed by a different signed-in user to self-grant.
 */
export async function verifySession(sessionId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const stripe = getStripeClient()
  if (!stripe) return false

  let session
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId)
  } catch (err) {
    // Fabricated/expired session id, or a Stripe outage. Fail closed — but log,
    // so a real outage doesn't silently read as "not granted" with no trace.
    console.error('verifySession: session retrieve failed', err)
    return false
  }

  if (session.payment_status !== 'paid') return false
  if (session.client_reference_id !== user.id) return false

  await grantEntitlement(sessionId)
  return true
}

/** Recovers a paid unlock if the success redirect never happened. */
export async function restorePurchase(): Promise<{ granted: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { granted: false }

  const { data: pending } = await supabase
    .from('pending_checkouts').select('stripe_session_id').eq('owner_id', user.id)

  let granted = false
  for (const row of pending ?? []) {
    if (await verifySession(row.stripe_session_id as string)) granted = true
  }
  if (granted) revalidatePath('/case/upgrade')
  return { granted }
}

/** Form-action wrapper: `<form action>` requires a void-returning function; the boolean
 * result of restorePurchase() is for callers that hold a reference (tests, future UI). */
export async function restorePurchaseAction(): Promise<void> {
  await restorePurchase()
}
