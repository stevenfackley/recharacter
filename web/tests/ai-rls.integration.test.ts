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
  alice = await makeUser(`ai_alice_${suffix}@example.test`)
  bob = await makeUser(`ai_bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user cannot read another user\'s AI credential', async () => {
  await alice.client.from('ai_credentials').insert({ owner_id: alice.id, encrypted_key: 'ciphertext' })
  const { data: bobSees } = await bob.client.from('ai_credentials').select('*')
  expect(bobSees).toEqual([])
})

test('a user cannot spoof-insert a credential for someone else', async () => {
  const { error } = await bob.client
    .from('ai_credentials').insert({ owner_id: alice.id, encrypted_key: 'evil' })
  expect(error).not.toBeNull()
})

test('usage rows are isolated and cannot be updated by their owner (insert-only ledger)', async () => {
  await alice.client.from('ai_usage').insert({
    owner_id: alice.id, task: 'ping', model: 'claude-opus-4-8',
    byok: false, input_tokens: 1, output_tokens: 1,
  })
  const { data: bobSees } = await bob.client.from('ai_usage').select('*')
  expect(bobSees).toEqual([])

  // No update policy exists → an owner update must affect zero rows.
  const { data: updated } = await alice.client
    .from('ai_usage').update({ output_tokens: 999999 }).eq('owner_id', alice.id).select()
  expect(updated).toEqual([])
})
