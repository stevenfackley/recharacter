import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'

export async function POST(request: NextRequest, ctx: { params: Promise<{ task: string }> }) {
  const { task: taskName } = await ctx.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid input for task' }, { status: 400 })
  }

  const result = await executeAiTask(supabase, user.id, taskName, input)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
