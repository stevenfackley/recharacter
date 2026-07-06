// @vitest-environment node
//
// Storage uploads/downloads exercise real Blob/FormData bodies over a real fetch
// call. The suite's default jsdom environment provides its own Blob/FormData
// classes; those don't `instanceof`-match the ones Node's native fetch (undici)
// recognizes, so a jsdom Blob upload silently serializes as the literal string
// "[object FormData]" instead of real multipart bytes. Forcing the Node
// environment for this file uses Node's own Blob/FormData end-to-end.
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
  alice = await makeUser(`st_alice_${suffix}@example.test`)
  bob = await makeUser(`st_bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user can upload to and read from their own folder', async () => {
  const path = `${alice.id}/case-x/dd214.txt`
  const { error: upErr } = await alice.client.storage
    .from('case-documents').upload(path, new Blob(['hello']), { upsert: true })
  expect(upErr).toBeNull()

  const { data, error: downErr } = await alice.client.storage
    .from('case-documents').download(path)
  expect(downErr).toBeNull()
  expect(await data!.text()).toBe('hello')
})

test('a user CANNOT upload into another user\'s folder', async () => {
  const { error } = await bob.client.storage
    .from('case-documents').upload(`${alice.id}/case-x/evil.txt`, new Blob(['evil']))
  expect(error).not.toBeNull()
})

test('a user CANNOT download another user\'s document', async () => {
  const { data, error } = await bob.client.storage
    .from('case-documents').download(`${alice.id}/case-x/dd214.txt`)
  expect(data).toBeNull()
  expect(error).not.toBeNull()
})
