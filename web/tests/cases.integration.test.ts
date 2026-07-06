import { afterAll, beforeAll, expect, test } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

// Mirror of getOrCreateCase's data logic, exercised directly against a signed-in client.
// (The Next server helper wraps this same query set; here we verify the idempotency contract.)
async function getOrCreate(client: SupabaseClient, userId: string) {
  const existing = await client
    .from('cases').select('*').eq('owner_id', userId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing.data) return existing.data
  const created = await client.from('cases').insert({ owner_id: userId }).select().single()
  if (created.error) throw created.error
  return created.data
}

let user: { id: string; client: SupabaseClient }

beforeAll(async () => {
  const email = `caseuser_${Math.random().toString(36).slice(2, 8)}@example.test`
  const { data } = await admin.auth.admin.createUser({ email, password: 'Password123!', email_confirm: true })
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  await client.auth.signInWithPassword({ email, password: 'Password123!' })
  user = { id: data.user!.id, client }
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(user.id)
})

test('getOrCreate is idempotent: two calls yield the same case', async () => {
  const first = await getOrCreate(user.client, user.id)
  const second = await getOrCreate(user.client, user.id)
  expect(second.id).toBe(first.id)

  const { data: all } = await user.client.from('cases').select('*')
  expect(all).toHaveLength(1) // exactly one case, not two
})
