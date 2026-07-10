import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The one-click data export/delete promised by docs/legal-posture.md ("Data
 * sensitivity"). Everything here runs against the veteran's OWN RLS-scoped
 * client except the final auth-user deletion, which needs the service-role
 * admin client — every table references auth.users(id) ON DELETE CASCADE, so
 * deleting the auth user is what wipes the rows, including the insert-only
 * ledgers (ai_usage, entitlements) that the veteran's own session is
 * deliberately unable to mutate.
 */

const BUCKET = 'case-documents'

export type AccountExport = {
  exportedAt: string
  userId: string
  email: string | null
  case: unknown
  serviceFacts: unknown
  caseContext: unknown
  evidenceItems: unknown[]
  nexusAnswers: unknown
  drafts: unknown[]
  aiUsage: unknown[]
  entitlements: unknown[]
  /** Whether a BYOK key is stored. The ciphertext itself is never exported. */
  byokConfigured: boolean
  /** Storage paths of uploaded records (the files belong to the veteran already). */
  uploadedDocuments: string[]
}

/**
 * Lists every object under the user's storage prefix. The bucket's path
 * convention is {user_id}/{case_id}/{file} — one folder level — but this
 * walks whatever depth exists so a future layout change can't silently
 * orphan files.
 */
export async function listUserObjects(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const paths: string[] = []
  const folders = [userId]
  while (folders.length > 0) {
    const folder = folders.pop()!
    const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 })
    if (error) throw error
    for (const entry of data ?? []) {
      // Storage list() marks folders with a null id.
      if (entry.id === null) folders.push(`${folder}/${entry.name}`)
      else paths.push(`${folder}/${entry.name}`)
    }
  }
  return paths
}

/** Gathers every row the veteran owns, through their own RLS-scoped client. */
export async function collectExport(
  supabase: SupabaseClient,
  userId: string,
  email: string | null,
): Promise<AccountExport> {
  const owned = (table: string) => supabase.from(table).select('*').eq('owner_id', userId)

  const [caseRow, facts, context, evidence, nexus, drafts, usage, entitlements, credential, documents] =
    await Promise.all([
      supabase.from('cases').select('*').eq('owner_id', userId).maybeSingle(),
      supabase.from('service_facts').select('*').eq('owner_id', userId).maybeSingle(),
      supabase.from('case_context').select('*').eq('owner_id', userId).maybeSingle(),
      owned('evidence_items'),
      supabase.from('nexus_answers').select('*').eq('owner_id', userId).maybeSingle(),
      owned('drafts'),
      owned('ai_usage'),
      supabase.from('entitlements').select('kind, created_at').eq('owner_id', userId),
      // Existence only — the encrypted key is ciphertext under our KEK and
      // must never leave the server, even in the owner's own export.
      supabase.from('ai_credentials').select('created_at').eq('owner_id', userId).maybeSingle(),
      listUserObjects(supabase, userId),
    ])

  return {
    exportedAt: new Date().toISOString(),
    userId,
    email,
    case: caseRow.data ?? null,
    serviceFacts: facts.data ?? null,
    caseContext: context.data ?? null,
    evidenceItems: evidence.data ?? [],
    nexusAnswers: nexus.data ?? null,
    drafts: drafts.data ?? [],
    aiUsage: usage.data ?? [],
    entitlements: entitlements.data ?? [],
    byokConfigured: credential.data !== null,
    uploadedDocuments: documents,
  }
}

/**
 * Permanently deletes the account: storage objects first (no FK cascade
 * reaches the bucket), then the auth user, which cascades through every
 * table. Throws on any failure — the caller must not report success unless
 * everything went.
 */
export async function deleteAccountData(opts: {
  userClient: SupabaseClient
  adminClient: SupabaseClient
  userId: string
}): Promise<void> {
  const paths = await listUserObjects(opts.userClient, opts.userId)
  if (paths.length > 0) {
    const { error } = await opts.userClient.storage.from(BUCKET).remove(paths)
    if (error) throw error
  }
  const { error } = await opts.adminClient.auth.admin.deleteUser(opts.userId)
  if (error) throw error
}
