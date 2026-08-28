// Liveness probe for the compose healthcheck and any external uptime monitor.
// Deliberately dependency-free: no Supabase, no auth — a DB or auth outage
// must not make the container report unhealthy and get killed/restarted.
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({ status: 'ok' })
}
