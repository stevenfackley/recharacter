import { createClient } from '@/lib/supabase/server'

export type Case = { id: string; owner_id: string; created_at: string; updated_at: string }

/** Returns the signed-in user's most recent case, creating one if none exists. */
export async function getOrCreateCase(): Promise<Case> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: existing } = await supabase
    .from('cases').select('*').eq('owner_id', user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing) return existing as Case

  const { data: created, error } = await supabase
    .from('cases').insert({ owner_id: user.id }).select().single()
  if (error) {
    // 23505 = unique_violation on cases_one_per_owner: a concurrent request won the
    // creation race between our select and insert. The row exists now — fetch it.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('cases').select('*').eq('owner_id', user.id).single()
      if (raced) return raced as Case
    }
    throw error
  }
  return created as Case
}
