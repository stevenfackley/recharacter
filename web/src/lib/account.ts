import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db'
import {
  cases, serviceFacts, caseContext, evidenceItems, nexusAnswers,
  drafts, aiUsage, aiCredentials, entitlements, pendingCheckouts,
} from '@/db/schema'
import type { ObjectStore } from '@/lib/storage/object-store'
import { listOwnerDocuments, removeOwnerDocuments } from '@/lib/case-documents'
import { createKeycloakAdmin, type KeycloakAdmin } from '@/lib/keycloak-admin'

/**
 * The one-click data export/delete promised by docs/legal-posture.md ("Data
 * sensitivity").
 *
 * There is no RLS behind these queries — the app role sees every row — so the
 * `owner_id` filter on each statement IS the access control, and every query
 * here carries one. Deletion spans three systems that no foreign key joins:
 * Postgres, the R2 bucket, and the Keycloak realm. The order below is what
 * makes that survivable; see deleteAccountData.
 */

type Row = Record<string, unknown>

const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * Drizzle returns JS field names and Date objects; the export is a document a
 * veteran (or their lawyer) reads, so it keeps the database's own column names
 * and ISO strings. This also keeps the JSON shape identical to the Supabase-era
 * export, which returned raw Postgres rows.
 */
export function serializeRow(row: Row | null | undefined): Row | null {
  if (!row) return null
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

const serializeRows = (rows: Row[]): Row[] => rows.map((r) => serializeRow(r)!)

export type AccountExport = {
  exportedAt: string
  ownerId: string
  case: Row | null
  serviceFacts: Row | null
  caseContext: Row | null
  evidenceItems: Row[]
  nexusAnswers: Row | null
  drafts: Row[]
  aiUsage: Row[]
  entitlements: Row[]
  pendingCheckouts: Row[]
  /** Existence and age only. The stored key is ciphertext under our KEK and never leaves the server. */
  aiCredentials: { present: boolean; created_at: string | null }
  /** Object keys of uploaded records; the files themselves are the veteran's own copies. */
  uploadedDocuments: string[]
}

/** Every row and object the owner has, assembled for download. */
export async function collectExport(ownerId: string, store: ObjectStore): Promise<AccountExport> {
  const db = getDb()
  const [
    caseRows, factRows, contextRows, evidenceRows, nexusRows,
    draftRows, usageRows, entitlementRows, checkoutRows, credentialRows, documents,
  ] = await Promise.all([
    db.select().from(cases).where(eq(cases.ownerId, ownerId)),
    db.select().from(serviceFacts).where(eq(serviceFacts.ownerId, ownerId)),
    db.select().from(caseContext).where(eq(caseContext.ownerId, ownerId)),
    db.select().from(evidenceItems).where(eq(evidenceItems.ownerId, ownerId)),
    db.select().from(nexusAnswers).where(eq(nexusAnswers.ownerId, ownerId)),
    db.select().from(drafts).where(eq(drafts.ownerId, ownerId)),
    db.select().from(aiUsage).where(eq(aiUsage.ownerId, ownerId)),
    db.select({ kind: entitlements.kind, createdAt: entitlements.createdAt })
      .from(entitlements).where(eq(entitlements.ownerId, ownerId)),
    db.select({ stripeSessionId: pendingCheckouts.stripeSessionId, createdAt: pendingCheckouts.createdAt })
      .from(pendingCheckouts).where(eq(pendingCheckouts.ownerId, ownerId)),
    // `createdAt` only — selecting the row would put the ciphertext one
    // spread operator away from the file the veteran downloads.
    db.select({ createdAt: aiCredentials.createdAt })
      .from(aiCredentials).where(eq(aiCredentials.ownerId, ownerId)),
    listOwnerDocuments(store, ownerId),
  ])

  return {
    exportedAt: new Date().toISOString(),
    ownerId,
    case: serializeRow(caseRows[0]),
    serviceFacts: serializeRow(factRows[0]),
    caseContext: serializeRow(contextRows[0]),
    evidenceItems: serializeRows(evidenceRows),
    nexusAnswers: serializeRow(nexusRows[0]),
    drafts: serializeRows(draftRows),
    aiUsage: serializeRows(usageRows),
    entitlements: serializeRows(entitlementRows),
    pendingCheckouts: serializeRows(checkoutRows),
    aiCredentials: {
      present: credentialRows.length > 0,
      created_at: credentialRows[0]?.createdAt.toISOString() ?? null,
    },
    uploadedDocuments: documents,
  }
}

/** Deletion cannot even be attempted: the Keycloak service account is unusable. */
export class DeletionUnavailableError extends Error {
  constructor(message = 'account deletion is unavailable', options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeletionUnavailableError'
  }
}

export type DeletionReceipt = { rowsByTable: Record<string, number>; objects: number }

/**
 * Permanently deletes everything tied to one owner, across all three systems.
 *
 * Order is the whole design. Keycloak is configured and its credentials proven
 * (steps 1-2) before a single row is touched, because a failure there after the
 * data is gone would leave a veteran with a login and an empty account and no
 * way back. Rows go next, in one transaction, so a mid-flight failure rolls the
 * whole set back. Objects follow — no foreign key reaches the bucket, and
 * removeOwnerDocuments re-lists to confirm the prefix is empty rather than
 * trusting the delete call. The identity is destroyed last, once nothing it
 * owns is left behind.
 *
 * Once that transaction commits there are two residual states a later failure
 * can leave, and both are deliberately retryable:
 *   - rows gone, objects and identity remain (the sweep threw);
 *   - rows and objects gone, only the identity remains (deleteUser threw).
 * Calling this again from either state converges: the sweep is driven by the
 * owner's prefix, not by a manifest, so it removes whatever is actually there;
 * the transaction deletes zero rows and reports zeroes; and Keycloak treats a
 * missing user as already deleted. The receipt's counts are therefore "what
 * this call removed", not "what the account ever held".
 *
 * Only counts are logged. Nothing in these rows is safe to put in a log line.
 */
export async function deleteAccountData(
  ownerId: string,
  deps: { store: ObjectStore; admin?: KeycloakAdmin },
): Promise<DeletionReceipt> {
  let admin: KeycloakAdmin
  try {
    admin = deps.admin ?? createKeycloakAdmin()
  } catch (err) {
    // Any failure to build the admin client — a missing secret, but also an
    // invalid environment from getEnv() — means deletion cannot start. They are
    // the same thing to the caller: nothing was removed.
    throw new DeletionUnavailableError(
      err instanceof Error ? err.message : String(err),
      { cause: err },
    )
  }

  // Throws on bad or missing credentials, with nothing deleted yet.
  const token = await admin.getToken()

  const rowsByTable = await getDb().transaction(async (tx) => {
    // The ai_usage/entitlements triggers raise 42501 on DELETE unless this is
    // set; SET LOCAL scopes it to this transaction and nothing else.
    await tx.execute(sql.raw(`SET LOCAL recharacter.allow_ledger_delete = 'on'`))

    const counted: Record<string, number> = {}
    counted.ai_usage = (await tx.delete(aiUsage).where(eq(aiUsage.ownerId, ownerId))
      .returning({ id: aiUsage.id })).length
    counted.entitlements = (await tx.delete(entitlements).where(eq(entitlements.ownerId, ownerId))
      .returning({ id: entitlements.id })).length
    counted.pending_checkouts = (await tx.delete(pendingCheckouts).where(eq(pendingCheckouts.ownerId, ownerId))
      .returning({ id: pendingCheckouts.id })).length
    counted.ai_credentials = (await tx.delete(aiCredentials).where(eq(aiCredentials.ownerId, ownerId))
      .returning({ id: aiCredentials.ownerId })).length

    // The five case-scoped tables disappear via ON DELETE CASCADE, which reports
    // nothing back — count them while they still exist so the receipt covers
    // every table rather than only the ones we name in a DELETE.
    counted.service_facts = (await tx.select({ id: serviceFacts.id }).from(serviceFacts)
      .where(eq(serviceFacts.ownerId, ownerId))).length
    counted.case_context = (await tx.select({ id: caseContext.id }).from(caseContext)
      .where(eq(caseContext.ownerId, ownerId))).length
    counted.evidence_items = (await tx.select({ id: evidenceItems.id }).from(evidenceItems)
      .where(eq(evidenceItems.ownerId, ownerId))).length
    counted.nexus_answers = (await tx.select({ id: nexusAnswers.id }).from(nexusAnswers)
      .where(eq(nexusAnswers.ownerId, ownerId))).length
    counted.drafts = (await tx.select({ id: drafts.id }).from(drafts)
      .where(eq(drafts.ownerId, ownerId))).length

    counted.cases = (await tx.delete(cases).where(eq(cases.ownerId, ownerId))
      .returning({ id: cases.id })).length

    // The cascade follows case_id, not owner_id. A row carrying this owner_id
    // but pointing at someone else's case would survive it, and the counts
    // above — taken before the delete — would report it as removed. Re-read the
    // five tables and refuse to commit if anything of theirs is still standing.
    const survivors: string[] = []
    if ((await tx.select({ id: serviceFacts.id }).from(serviceFacts)
      .where(eq(serviceFacts.ownerId, ownerId))).length) survivors.push('service_facts')
    if ((await tx.select({ id: caseContext.id }).from(caseContext)
      .where(eq(caseContext.ownerId, ownerId))).length) survivors.push('case_context')
    if ((await tx.select({ id: evidenceItems.id }).from(evidenceItems)
      .where(eq(evidenceItems.ownerId, ownerId))).length) survivors.push('evidence_items')
    if ((await tx.select({ id: nexusAnswers.id }).from(nexusAnswers)
      .where(eq(nexusAnswers.ownerId, ownerId))).length) survivors.push('nexus_answers')
    if ((await tx.select({ id: drafts.id }).from(drafts)
      .where(eq(drafts.ownerId, ownerId))).length) survivors.push('drafts')
    if (survivors.length) {
      throw new Error(`rows survived the case cascade in ${survivors.join(', ')}; deletion rolled back`)
    }

    return counted
  })

  const objects = await removeOwnerDocuments(deps.store, ownerId)

  await admin.deleteUser(ownerId, token)

  // No owner id: the account it named no longer exists, so keeping it here only
  // leaves a dangling identifier in the logs of a "delete everything" feature.
  console.info('account deleted', { rowsByTable, objects })
  return { rowsByTable, objects }
}
