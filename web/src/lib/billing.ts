import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * The freemium gate. Entitled = paid unlock OR a BYOK key on file — a veteran
 * who brings their own Anthropic key already bears the AI cost, so charging
 * them again would be double-dipping (design spec §10).
 */
export async function isEntitled(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const [{ data: paid }, { data: byok }] = await Promise.all([
    supabase.from('entitlements').select('id').eq('owner_id', userId).maybeSingle(),
    supabase.from('ai_credentials').select('owner_id').eq('owner_id', userId).maybeSingle(),
  ])
  return Boolean(paid) || Boolean(byok)
}

export async function recordPendingCheckout(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('pending_checkouts').insert({ owner_id: user.id, stripe_session_id: sessionId })
  if (error) throw error
}

/** Idempotent: 23505 on the unique session id means it's already recorded. */
export async function grantEntitlement(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('entitlements')
    .insert({ owner_id: user.id, kind: 'case_unlock', stripe_session_id: sessionId })
  if (error && error.code !== '23505') throw error
  await supabase.from('pending_checkouts').delete().eq('stripe_session_id', sessionId)
}
