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

  let result
  try {
    result = await executeAiTask(user.id, taskName, input)
  } catch (err) {
    // The gateway rejects (rather than resolving a refusal) when it cannot even
    // record the attempt. The message is ours; the input is the veteran's, and
    // none of it goes to a log.
    console.error(`ai task ${taskName} failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'ai_unavailable' }, { status: 503 })
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
