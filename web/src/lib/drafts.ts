import { createClient } from '@/lib/supabase/server'

export type DraftKind = 'personal_statement' | 'cover_letter'

export type Draft = {
  kind: DraftKind
  content: string
  edited: boolean
  generated_at: string
}

export async function getDraft(caseId: string, kind: DraftKind): Promise<Draft | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('drafts').select('kind, content, edited, generated_at')
    .eq('case_id', caseId).eq('kind', kind).maybeSingle()
  return (data as Draft | null) ?? null
}

/** Writes a freshly GENERATED draft (resets edited=false). */
export async function saveGeneratedDraft(caseId: string, kind: DraftKind, content: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase.from('drafts').upsert(
    {
      case_id: caseId, owner_id: user.id, kind, content,
      edited: false, generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id,kind' },
  )
  if (error) throw error
}

/** Writes the veteran's EDITED text (sets edited=true, preserves generated_at). */
export async function saveEditedDraft(caseId: string, kind: DraftKind, content: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase.from('drafts')
    .update({ content, edited: true, updated_at: new Date().toISOString() })
    .eq('case_id', caseId).eq('kind', kind).eq('owner_id', user.id)
  if (error) throw error
}
