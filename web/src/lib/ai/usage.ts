import type { SupabaseClient } from '@supabase/supabase-js'

export async function recordUsage(
  supabase: SupabaseClient,
  row: {
    owner_id: string
    task: string
    model: string
    byok: boolean
    input_tokens: number
    output_tokens: number
  },
): Promise<void> {
  // Metering failures must not eat a successful AI response — swallow BOTH the
  // resolved-{error} shape and a thrown rejection; log and continue.
  try {
    const { error } = await supabase.from('ai_usage').insert(row)
    if (error) console.error('ai_usage insert failed', error)
  } catch (err) {
    console.error('ai_usage insert threw', err)
  }
}
