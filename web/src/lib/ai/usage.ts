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
  const { error } = await supabase.from('ai_usage').insert(row)
  // Metering failures must not eat a successful AI response; log and continue.
  if (error) console.error('ai_usage insert failed', error)
}
