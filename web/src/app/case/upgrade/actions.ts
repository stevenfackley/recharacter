'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireSessionUser } from '@/lib/session'
import { getEnv } from '@/lib/env'
import { recordPendingCheckout } from '@/lib/billing'
import { getStripeClient, restorePurchase } from '@/lib/billing-verify'

/**
 * Only real form actions live here. Everything exported from a 'use server'
 * module is a public RPC endpoint the browser can call with arguments of its
 * choosing, so the verification helpers stay in lib/billing-verify.ts — reached
 * only through these two, which resolve the owner from the session first.
 */

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

/** "Restore a previous purchase" — the button's only entry point. */
export async function restorePurchaseAction(): Promise<void> {
  const user = await requireSessionUser('/case/upgrade')
  const { granted } = await restorePurchase(user.id)
  if (granted) revalidatePath('/case/upgrade')
}
