import type { ServiceFacts } from '@/lib/facts'

/**
 * Mirror of the .NET RoutingResult record. Enum VALUES are PascalCase strings
 * ("Drb", "DD293") while property KEYS are camelCase — that asymmetry comes from
 * the API's JsonStringEnumConverter and is intentional.
 */
export type RoutingResult = {
  recommendedBoard: 'Drb' | 'Bcmr'
  recommendedForm: 'DD293' | 'DD149'
  boardName: string
  availableBoards: Array<'Drb' | 'Bcmr'>
  drbDeadline: string
  drbWindowOpen: boolean
  flags: string[]
}

export async function routeDischarge(facts: ServiceFacts): Promise<RoutingResult> {
  const base = process.env.ROUTING_API_URL
  if (!base) throw new Error('Routing service not configured (ROUTING_API_URL)')

  const res = await fetch(`${base}/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(facts),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Routing service error: ${res.status}`)
  return res.json()
}
