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
    email, password: 'Password123!', email_confirm: true,
  })
  if (error) throw error
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  await client.auth.signInWithPassword({ email, password: 'Password123!' })
  return { id: data.user!.id, client }
}

let alice: Awaited<ReturnType<typeof makeUser>>
let bob: Awaited<ReturnType<typeof makeUser>>

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`en_alice_${suffix}@example.test`)
  bob = await makeUser(`en_bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user cannot read another user\'s entitlement (RLS isolation)', async () => {
  const { error: insertErr } = await alice.client
    .from('entitlements')
    .insert({ owner_id: alice.id, stripe_session_id: `cs_ent_own_${alice.id}` })
  expect(insertErr).toBeNull()

  const { data: bobSees } = await bob.client.from('entitlements').select('*')
  expect(bobSees).toEqual([])
})

test('a user cannot spoof-insert an entitlement for someone else', async () => {
  const { error } = await bob.client
    .from('entitlements')
    .insert({ owner_id: alice.id, stripe_session_id: `cs_ent_spoof_${alice.id}` })
  expect(error).not.toBeNull()
})

test('entitlements are client-immutable: owner UPDATE and DELETE are refused with 42501', async () => {
  // Alice already has an entitlement row from the first test.
  const { data: updated, error: updateErr } = await alice.client
    .from('entitlements').update({ kind: 'case_unlock' }).eq('owner_id', alice.id).select()
  expect(updateErr?.code).toBe('42501')
  expect(updated).toBeNull()

  const { data: deleted, error: deleteErr } = await alice.client
    .from('entitlements').delete().eq('owner_id', alice.id).select()
  expect(deleteErr?.code).toBe('42501')
  expect(deleted).toBeNull()

  // The row must still be there — no client action can revoke it.
  const { data: still } = await alice.client.from('entitlements').select('*')
  expect(still!.length).toBeGreaterThanOrEqual(1)
})

test('a second entitlement for the same owner violates the one-per-owner unique constraint', async () => {
  const { error } = await alice.client
    .from('entitlements')
    .insert({ owner_id: alice.id, stripe_session_id: `cs_ent_second_${alice.id}` })
  expect(error?.code).toBe('23505')
})

test('pending_checkouts are isolated between users', async () => {
  const { error: insertErr } = await alice.client
    .from('pending_checkouts')
    .insert({ owner_id: alice.id, stripe_session_id: `cs_pending_own_${alice.id}` })
  expect(insertErr).toBeNull()

  const { data: bobSees } = await bob.client.from('pending_checkouts').select('*')
  expect(bobSees).toEqual([])
})

test('a user cannot spoof-insert a pending checkout for someone else', async () => {
  const { error } = await bob.client
    .from('pending_checkouts')
    .insert({ owner_id: alice.id, stripe_session_id: `cs_pending_spoof_${alice.id}` })
  expect(error).not.toBeNull()
})

test('a user cannot update another user\'s pending checkout, and UPDATE is refused outright (42501)', async () => {
  const { data: updated, error: updateErr } = await alice.client
    .from('pending_checkouts')
    .update({ stripe_session_id: 'cs_tampered' })
    .eq('owner_id', alice.id)
    .select()
  expect(updateErr?.code).toBe('42501')
  expect(updated).toBeNull()
})

test('a user CAN delete their own pending checkout (the "restore purchase" cleanup path)', async () => {
  const sessionId = `cs_pending_delete_${alice.id}`
  await alice.client.from('pending_checkouts').insert({ owner_id: alice.id, stripe_session_id: sessionId })

  const { data: bobDeleteAttempt } = await bob.client
    .from('pending_checkouts').delete().eq('stripe_session_id', sessionId).select()
  expect(bobDeleteAttempt).toEqual([]) // RLS-filtered: zero rows affected for Bob

  const { data: deleted, error } = await alice.client
    .from('pending_checkouts').delete().eq('stripe_session_id', sessionId).select()
  expect(error).toBeNull()
  expect(deleted).toHaveLength(1)
})
