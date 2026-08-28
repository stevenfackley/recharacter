import { and, eq, ne } from 'drizzle-orm'
import { getDb } from '@/db'
import { aiCredentials, entitlements, pendingCheckouts } from '@/db/schema'

/**
 * The freemium gate. Entitled = paid unlock OR a BYOK key on file — a veteran
 * who brings their own Anthropic key already bears the AI cost, so charging
 * them again would be double-dipping (design spec §10).
 */
export async function isEntitled(ownerId: string): Promise<boolean> {
  const db = getDb()
  const [paid, byok] = await Promise.all([
    db.select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.ownerId, ownerId)).limit(1),
    db.select({ ownerId: aiCredentials.ownerId }).from(aiCredentials).where(eq(aiCredentials.ownerId, ownerId)).limit(1),
  ])
  return paid.length > 0 || byok.length > 0
}

export async function recordPendingCheckout(ownerId: string, sessionId: string): Promise<void> {
  await getDb().insert(pendingCheckouts).values({ ownerId, stripeSessionId: sessionId })
}

/** Session ids this owner started a checkout for and never got an entitlement from. */
export async function listPendingCheckouts(ownerId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ stripeSessionId: pendingCheckouts.stripeSessionId })
    .from(pendingCheckouts)
    .where(eq(pendingCheckouts.ownerId, ownerId))
  return rows.map((r) => r.stripeSessionId)
}

/**
 * Grants the case unlock for a paid checkout session.
 *
 * Idempotent by construction: `on conflict (owner_id) do nothing ... returning`
 * hands back a row only when THIS call created the entitlement, so a webhook
 * redelivery reports 'already_entitled' instead of erroring or double-granting.
 *
 * The one case that must NOT be silent is an empty return with no entitlement to
 * show for it: that means the insert was rejected by the unique on
 * stripe_session_id, i.e. this session id already belongs to a DIFFERENT owner.
 * Swallowing it would hand one person's purchase to another account.
 */
export async function grantEntitlement(
  ownerId: string,
  sessionId: string,
): Promise<'granted' | 'already_entitled'> {
  const db = getDb()
  const granted = await db
    .insert(entitlements)
    .values({ ownerId, kind: 'case_unlock', stripeSessionId: sessionId })
    .onConflictDoNothing({ target: entitlements.ownerId })
    .returning()

  if (granted.length > 0) {
    await clearPendingCheckout(ownerId, sessionId)
    return 'granted'
  }

  const [existing] = await db
    .select({ stripeSessionId: entitlements.stripeSessionId })
    .from(entitlements)
    .where(eq(entitlements.ownerId, ownerId))
    .limit(1)
  if (!existing) {
    throw new Error(`checkout session ${sessionId} could not be granted to ${ownerId}`)
  }

  // Two different reasons the incoming session id can differ from the one on
  // file, and only one of them is benign. Before writing it off as a duplicate
  // purchase, check whether that session id is already spent by ANOTHER account:
  // if it is, this call is trying to credit one person's payment to a second
  // owner, and the on-conflict-do-nothing above hid it because the owner_id
  // unique fired first. That is a billing fraud signal, not a log line.
  if (existing.stripeSessionId !== sessionId) {
    const [claimedElsewhere] = await db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(and(eq(entitlements.stripeSessionId, sessionId), ne(entitlements.ownerId, ownerId)))
      .limit(1)
    if (claimedElsewhere) throw new Error('stripe session belongs to another account')
  }

  // A second paid session for an owner who already holds the one-per-owner
  // unlock. Worth a look in the logs (a possible refund), never worth failing
  // the webhook over.
  console.warn('entitlement already held', {
    ownerId,
    existing: existing.stripeSessionId,
    incoming: sessionId,
  })
  await clearPendingCheckout(ownerId, sessionId)
  return 'already_entitled'
}

/** Owner-scoped: a session id alone is not authority to clear someone's pending row. */
export async function clearPendingCheckout(ownerId: string, sessionId: string): Promise<void> {
  await getDb()
    .delete(pendingCheckouts)
    .where(
      and(eq(pendingCheckouts.ownerId, ownerId), eq(pendingCheckouts.stripeSessionId, sessionId)),
    )
}

/**
 * The PAID half of isEntitled, on its own.
 *
 * The upgrade page needs the distinction isEntitled deliberately erases: a
 * veteran who paid is thanked for paying, whether or not they also brought
 * their own key, and only an unpaid BYOK account is told it is unlocked
 * through that key.
 */
export async function hasPaidEntitlement(ownerId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(eq(entitlements.ownerId, ownerId))
    .limit(1)
  return rows.length > 0
}
