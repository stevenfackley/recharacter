'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import Stripe from 'stripe'
import { getSessionUser, requireSessionUser } from '@/lib/session'
import { getEnv } from '@/lib/env'
import {
  recordPendingCheckout, grantEntitlement, listPendingCheckouts,
} from '@/lib/billing'

/**
 * A single restore must not fan out into an unbounded number of Stripe
 * round-trips: one veteran with a long history of abandoned checkouts would turn
 * one button press into dozens of API calls. Five is well past any honest case.
 */
const MAX_RESTORE_SESSIONS = 5

/** Null when Stripe isn't configured — the friendly "not yet configured" path, never a crash. */
function getStripeClient(): Stripe | null {
  const key = getEnv().STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key)
}

/** Starts hosted Stripe Checkout for the one-time case unlock. */
export async function startCheckout() {
  const user = await requireSessionUser('/case/upgrade')

  const stripe = getStripeClient()
  const env = getEnv()
  const priceId = env.STRIPE_PRICE_ID
  if (!stripe || !priceId) {
    redirect('/case/upgrade?error=not_configured')
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    success_url: `${env.APP_BASE_URL}/case/upgrade?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_BASE_URL}/case/upgrade?canceled=1`,
  })

  await recordPendingCheckout(user.id, session.id)

  if (!session.url) {
    redirect('/case/upgrade?error=checkout_failed')
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
  const user = await getSessionUser()
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

  try {
    // 'already_entitled' is success: a redelivered success redirect must not
    // read as a failed purchase to the veteran who already paid.
    await grantEntitlement(user.id, sessionId)
  } catch (err) {
    // The one failure grantEntitlement refuses to swallow is a session id that
    // belongs to a DIFFERENT owner. Fail closed.
    console.error('verifySession: entitlement grant failed', err)
    return false
  }
  return true
}

/** Recovers a paid unlock if the success redirect never happened. */
export async function restorePurchase(): Promise<{ granted: boolean }> {
  const user = await getSessionUser()
  if (!user) return { granted: false }

  const pending = (await listPendingCheckouts(user.id)).slice(0, MAX_RESTORE_SESSIONS)

  let granted = false
  for (const sessionId of pending) {
    if (await verifySession(sessionId)) granted = true
  }
  if (granted) revalidatePath('/case/upgrade')
  return { granted }
}

/** Form-action wrapper: `<form action>` requires a void-returning function; the boolean
 * result of restorePurchase() is for callers that hold a reference (tests, future UI). */
export async function restorePurchaseAction(): Promise<void> {
  await restorePurchase()
}
