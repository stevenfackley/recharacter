import { beforeAll, afterAll, expect, test } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

async function makeUser(email: string): Promise<{ id: string; client: SupabaseClient }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'Password123!',
    email_confirm: true,
  })
  if (error) throw error
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: 'Password123!' })
  if (signInErr) throw signInErr
  return { id: data.user!.id, client }
}

let alice: { id: string; client: SupabaseClient }
let bob: { id: string; client: SupabaseClient }
let aliceCaseId: string

beforeAll(async () => {
  // Unique emails per run so repeated runs don't collide.
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`nx_alice_${suffix}@example.test`)
  bob = await makeUser(`nx_bob_${suffix}@example.test`)

  // Alice needs a case row before she can attach nexus_answers / drafts to it.
  const { data: created, error } = await alice.client
    .from('cases').insert({ owner_id: alice.id }).select().single()
  if (error) {
    // 23505 = unique_violation on cases_one_per_owner — reuse the existing row.
    if (error.code === '23505') {
      const { data: existing } = await alice.client
        .from('cases').select('*').eq('owner_id', alice.id).single()
      aliceCaseId = existing!.id
    } else {
      throw error
    }
  } else {
    aliceCaseId = created!.id
  }
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user can insert and read their own nexus_answers row; another user sees none', async () => {
  const { data, error } = await alice.client.from('nexus_answers').insert({
    case_id: aliceCaseId,
    owner_id: alice.id,
    q1_condition: 'adjustment disorder',
  }).select().single()
  expect(error).toBeNull()
  expect(data!.owner_id).toBe(alice.id)

  const { data: bobSees } = await bob.client.from('nexus_answers').select('*')
  expect(bobSees).toEqual([]) // RLS filters Alice's row out entirely for Bob
})

test('a user CANNOT spoof-insert a nexus_answers row owned by someone else', async () => {
  const { error } = await bob.client.from('nexus_answers').insert({
    case_id: aliceCaseId,
    owner_id: alice.id,
    q1_condition: 'spoofed',
  })
  expect(error).not.toBeNull() // insert WITH CHECK (auth.uid() = owner_id) rejects the spoof
})

test('drafts rows are isolated per owner and cannot be updated cross-owner', async () => {
  const { data, error } = await alice.client.from('drafts').insert({
    case_id: aliceCaseId,
    owner_id: alice.id,
    kind: 'personal_statement',
    content: 'My statement...',
  }).select().single()
  expect(error).toBeNull()
  expect(data!.owner_id).toBe(alice.id)

  const { data: bobSees } = await bob.client.from('drafts').select('*')
  expect(bobSees).toEqual([])

  const { data: updated } = await bob.client
    .from('drafts')
    .update({ content: 'hijacked' })
    .eq('owner_id', alice.id)
    .select()
  expect(updated).toEqual([])
})

test('a duplicate (case_id, kind) draft insert violates the unique constraint', async () => {
  const { error } = await alice.client.from('drafts').insert({
    case_id: aliceCaseId,
    owner_id: alice.id,
    kind: 'personal_statement',
    content: 'again',
  })
  expect(error?.code).toBe('23505')
})
