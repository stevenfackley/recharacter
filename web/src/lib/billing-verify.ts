import Stripe from 'stripe'
import { getEnv } from '@/lib/env'
import { grantEntitlement, listPendingCheckouts } from '@/lib/billing'

/**
 * Checkout verification, deliberately OUTSIDE the 'use server' module.
 *
 * Everything exported from a server-action file is a public RPC endpoint the
 * browser can call with arbitrary arguments. These two are not actions: a
 * caller who could reach restorePurchase directly would be handed an unmetered
 * loop of stripe.checkout.sessions.retrieve, and one who could reach
 * verifySession directly would choose the session id AND the owner it is
 * checked against. They take the owner id from their caller, which resolves it
 * from the session.
 */

/**
 * A single restore must not fan out into an unbounded number of Stripe
 * round-trips: one veteran with a long history of abandoned checkouts would turn
 * one button press into dozens of API calls. Five is well past any honest case.
 */
const MAX_RESTORE_SESSIONS = 5

/** Null when Stripe isn't configured — the friendly "not yet configured" path, never a crash. */
export function getStripeClient(): Stripe | null {
  const key = getEnv().STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key)
}

/**
 * The security-critical check: a session grants an entitlement ONLY when Stripe
 * confirms it was actually paid AND it was created for THIS user
 * (client_reference_id) — otherwise a session id leaked via a shared link or a
 * server log could be replayed by a different signed-in user to self-grant.
 */
export async function verifySession(ownerId: string, sessionId: string): Promise<boolean> {
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
  if (session.client_reference_id !== ownerId) return false

  try {
    // 'already_entitled' is success: a redelivered success redirect must not
    // read as a failed purchase to the veteran who already paid.
    await grantEntitlement(ownerId, sessionId)
  } catch (err) {
    // The one failure grantEntitlement refuses to swallow is a session id that
    // belongs to a DIFFERENT owner. Fail closed.
    console.error('verifySession: entitlement grant failed', err)
    return false
  }
  return true
}

/** Recovers a paid unlock if the success redirect never happened. */
export async function restorePurchase(ownerId: string): Promise<{ granted: boolean }> {
  const pending = (await listPendingCheckouts(ownerId)).slice(0, MAX_RESTORE_SESSIONS)

  let granted = false
  for (const sessionId of pending) {
    if (await verifySession(ownerId, sessionId)) granted = true
  }
  return { granted }
}
