import { createClient } from '@/lib/supabase/server'
import { saveByokKey, removeByokKey } from './actions'

export default async function AiSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null // middleware redirects; this is belt-and-suspenders

  const { data: credential } = await supabase
    .from('ai_credentials').select('created_at').eq('owner_id', user.id).maybeSingle()

  const { data: usage } = await supabase
    .from('ai_usage').select('input_tokens, output_tokens').eq('owner_id', user.id)
  const totals = (usage ?? []).reduce(
    (acc, r) => ({ input: acc.input + r.input_tokens, output: acc.output + r.output_tokens }),
    { input: 0, output: 0 },
  )

  return (
    <main>
      <h1>AI settings</h1>

      <section>
        <h2>Your own API key (BYOK)</h2>
        {credential ? (
          <>
            <p>A key is saved (encrypted). AI requests bill your own Anthropic account.</p>
            <form action={removeByokKey}>
              <button type="submit">Remove my key</button>
            </form>
          </>
        ) : (
          <>
            <p>No key saved — the managed tier is in use.</p>
            <form action={saveByokKey}>
              <input name="apiKey" type="password" placeholder="sk-ant-..." required />
              <button type="submit">Save key</button>
            </form>
          </>
        )}
      </section>

      <section>
        <h2>Usage</h2>
        <p>{totals.input.toLocaleString()} input / {totals.output.toLocaleString()} output tokens</p>
      </section>
    </main>
  )
}
