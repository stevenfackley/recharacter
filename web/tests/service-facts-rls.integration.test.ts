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

// Valid facts row shared by every test that needs one — only the case_id/owner_id vary.
const validFacts = {
  branch: 'MarineCorps',
  discharge_date: '2024-06-01',
  characterization: 'OtherThanHonorable',
  was_general_court_martial: false,
}

beforeAll(async () => {
  // Unique emails per run so repeated runs don't collide (no Date.now available in engine,
  // but this is a Node test process — a random suffix is fine here).
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`sf_alice_${suffix}@example.test`)
  bob = await makeUser(`sf_bob_${suffix}@example.test`)

  // service_facts.case_id references cases (one-per-owner) — create Alice's case up front
  // so every test below can reference it.
  const { data: aliceCase, error } = await alice.client
    .from('cases').insert({ owner_id: alice.id }).select().single()
  if (error) throw error
  aliceCaseId = aliceCase!.id
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('an owner can insert and read their own facts row', async () => {
  const { data, error } = await alice.client
    .from('service_facts')
    .insert({ case_id: aliceCaseId, owner_id: alice.id, ...validFacts })
    .select()
    .single()
  expect(error).toBeNull()
  expect(data!.owner_id).toBe(alice.id)

  const { data: rows } = await alice.client.from('service_facts').select('*')
  expect(rows).toHaveLength(1)
})

test('bob cannot read alice\'s facts (RLS isolation)', async () => {
  const { data: bobSees } = await bob.client.from('service_facts').select('*')
  expect(bobSees).toEqual([]) // RLS filters Alice's rows out entirely for Bob
})

test('bob cannot spoof-insert facts with owner_id: alice.id', async () => {
  const { error } = await bob.client
    .from('service_facts')
    .insert({ case_id: aliceCaseId, owner_id: alice.id, ...validFacts })
  expect(error).not.toBeNull() // insert WITH CHECK (auth.uid() = owner_id) rejects the spoof
})

test('bob cannot update alice\'s facts', async () => {
  // Alice has a facts row from the first test. An RLS-filtered UPDATE affects zero rows.
  const { data: updated } = await bob.client
    .from('service_facts')
    .update({ was_general_court_martial: true })
    .eq('owner_id', alice.id)
    .select()
  expect(updated).toEqual([])
})

test('a second facts row for the same case_id violates the one-per-case constraint', async () => {
  const { error } = await alice.client
    .from('service_facts')
    .insert({ case_id: aliceCaseId, owner_id: alice.id, ...validFacts })
  expect(error?.code).toBe('23505') // service_facts_case_id_key unique constraint
})
