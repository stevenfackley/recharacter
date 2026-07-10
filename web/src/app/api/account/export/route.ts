import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { collectExport } from '@/lib/account'

/**
 * One-click data export (docs/legal-posture.md, "Data sensitivity"). Runs
 * entirely through the veteran's own RLS-scoped session — no service role —
 * so it can only ever return what the requester owns.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const data = await collectExport(supabase, user.id, user.email ?? null)
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="recharacter-export.json"',
    },
  })
}
