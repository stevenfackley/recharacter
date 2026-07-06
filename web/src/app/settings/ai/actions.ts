'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { encryptSecret } from '@/lib/ai/crypto'

export async function saveByokKey(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const apiKey = String(formData.get('apiKey') ?? '').trim()
  if (!apiKey) throw new Error('API key is required')

  const encrypted = encryptSecret(apiKey, process.env.AI_KEY_ENCRYPTION_SECRET!)
  const { error } = await supabase
    .from('ai_credentials')
    .upsert({ owner_id: user.id, encrypted_key: encrypted, updated_at: new Date().toISOString() })
  if (error) throw error
  revalidatePath('/settings/ai')
}

export async function removeByokKey() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('ai_credentials').delete().eq('owner_id', user.id)
  revalidatePath('/settings/ai')
}
