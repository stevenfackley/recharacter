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

beforeAll(async () => {
  // Unique emails per run so repeated runs don't collide (no Date.now available in engine,
  // but this is a Node test process — a random suffix is fine here).
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`alice_${suffix}@example.test`)
  bob = await makeUser(`bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user can insert and read their own case', async () => {
  const { data, error } = await alice.client.from('cases').insert({ owner_id: alice.id }).select().single()
  expect(error).toBeNull()
  expect(data!.owner_id).toBe(alice.id)

  const { data: rows } = await alice.client.from('cases').select('*')
  expect(rows).toHaveLength(1)
})

test('a user CANNOT read another user\'s case (RLS isolation)', async () => {
  await alice.client.from('cases').insert({ owner_id: alice.id })

  const { data: bobSees } = await bob.client.from('cases').select('*')
  expect(bobSees).toEqual([]) // RLS filters Alice's rows out entirely for Bob
})

test('a user CANNOT insert a case owned by someone else', async () => {
  const { error } = await bob.client.from('cases').insert({ owner_id: alice.id })
  expect(error).not.toBeNull() // insert WITH CHECK (auth.uid() = owner_id) rejects the spoof
})

test('an anonymous client sees no cases', async () => {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data } = await anon.from('cases').select('*')
  expect(data).toEqual([])
})
