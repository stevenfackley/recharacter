import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getObjectStore } from '@/lib/storage'
import { collectExport } from '@/lib/account'

/**
 * One-click data export (docs/legal-posture.md, "Data sensitivity"). Every query
 * behind collectExport is owner-scoped to the signed-in id, so the file can only
 * ever contain what the requester owns.
 *
 * The body is the veteran's whole record: no-store keeps it out of every shared
 * cache, and Vary: Cookie keeps a cache from ever keying one account's export on
 * a request that another account could repeat.
 */
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const

export async function GET() {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: PRIVATE_HEADERS })
  }

  const data = await collectExport(user.id, getObjectStore())
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="recharacter-export.json"',
    },
  })
}
