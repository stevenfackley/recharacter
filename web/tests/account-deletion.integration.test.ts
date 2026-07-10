// @vitest-environment node
//
// Storage uploads need Node's own Blob/FormData (see storage-rls test for the
// jsdom/undici mismatch this avoids).
//
// The deletion promise, proven end-to-end against real RLS + real FK cascades:
// deleting Alice removes every row she owns in EVERY table — including the
// insert-only ai_usage ledger her own session cannot touch — plus her storage
// objects, while Bob's identical data survives untouched.
import { beforeAll, afterAll, expect, test } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { collectExport, deleteAccountData } from '@/lib/account'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

const OWNER_TABLES = [
  'cases', 'service_facts', 'case_context', 'evidence_items',
  'nexus_answers', 'drafts', 'ai_usage', 'ai_credentials',
] as const

async function makeUser(email: string): Promise<{ id: string; client: SupabaseClient }> {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: 'Password123!', email_confirm: true,
  })
  if (error) throw error
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: 'Password123!' })
  if (signInErr) throw signInErr
  return { id: data.user!.id, client }
}

/** Seeds one row in every owner-scoped table plus one storage object. */
async function seed(user: { id: string; client: SupabaseClient }) {
  const { data: caseRow, error: caseErr } = await user.client
    .from('cases').insert({ owner_id: user.id }).select().single()
  if (caseErr) throw caseErr
  const caseId = caseRow.id as string

  const inserts: Array<[string, Record<string, unknown>]> = [
    ['service_facts', {
      case_id: caseId, owner_id: user.id, branch: 'Army',
      discharge_date: '2015-04-01', characterization: 'OtherThanHonorable',
    }],
    ['case_context', { case_id: caseId, owner_id: user.id, condition_category: 'ptsd' }],
    ['evidence_items', { case_id: caseId, owner_id: user.id, item_type: 'dd214', status: 'collected' }],
    ['nexus_answers', { case_id: caseId, owner_id: user.id, q1_condition: 'seeded answer' }],
    ['drafts', { case_id: caseId, owner_id: user.id, kind: 'personal_statement', content: 'seeded draft' }],
    ['ai_usage', { owner_id: user.id, task: 'ping', model: 'test', input_tokens: 1, output_tokens: 1 }],
    ['ai_credentials', { owner_id: user.id, encrypted_key: 'c2VlZGVkLWNpcGhlcnRleHQ=' }],
  ]
  for (const [table, row] of inserts) {
    const { error } = await user.client.from(table).insert(row)
    if (error) throw new Error(`seeding ${table}: ${error.message}`)
  }

  const { error: upErr } = await user.client.storage
    .from('case-documents')
    .upload(`${user.id}/${caseId}/dd214.txt`, new Blob(['seeded document']), { upsert: true })
  if (upErr) throw upErr
}

async function adminRowCount(table: string, ownerId: string): Promise<number> {
  const { data, error } = await admin.from(table).select('owner_id').eq('owner_id', ownerId)
  if (error) throw error
  return data.length
}

let alice: { id: string; client: SupabaseClient }
let bob: { id: string; client: SupabaseClient }
let aliceDeleted = false

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`del_alice_${suffix}@example.test`)
  bob = await makeUser(`del_bob_${suffix}@example.test`)
  await seed(alice)
  await seed(bob)
}, 30_000)

afterAll(async () => {
  if (!aliceDeleted) await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('export sees the seeded data through the owner session', async () => {
  const result = await collectExport(alice.client, alice.id, 'alice@example.test')
  expect(result.case).not.toBeNull()
  expect(result.byokConfigured).toBe(true)
  expect(result.aiUsage).toHaveLength(1)
  expect(result.uploadedDocuments).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('c2VlZGVkLWNpcGhlcnRleHQ=')
})

test('deleting Alice wipes every table and her storage; Bob is untouched', async () => {
  await deleteAccountData({ userClient: alice.client, adminClient: admin, userId: alice.id })
  aliceDeleted = true

  for (const table of OWNER_TABLES) {
    expect(await adminRowCount(table, alice.id), `${table} for alice`).toBe(0)
    expect(await adminRowCount(table, bob.id), `${table} for bob`).toBe(1)
  }

  // Storage: admin sees the truth regardless of policies.
  const { data: aliceFolders } = await admin.storage.from('case-documents').list(alice.id)
  expect(aliceFolders ?? []).toHaveLength(0)
  const { data: bobFolders } = await admin.storage.from('case-documents').list(bob.id)
  expect((bobFolders ?? []).length).toBeGreaterThan(0)

  // The auth user itself is gone.
  const { data: gone } = await admin.auth.admin.getUserById(alice.id)
  expect(gone.user).toBeNull()
}, 30_000)
