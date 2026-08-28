import { NextResponse, type NextRequest } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { executeAiTask } from '@/lib/ai/gateway'

export async function POST(request: NextRequest, ctx: { params: Promise<{ task: string }> }) {
  const { task: taskName } = await ctx.params

  // The proxy is a redirect convenience, not the gate: every protected handler
  // resolves the session itself.
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid input for task' }, { status: 400 })
  }

  const result = await executeAiTask(user.id, taskName, input)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
