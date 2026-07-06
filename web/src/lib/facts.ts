import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'

export const BRANCHES = ['Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard'] as const
export const CHARACTERIZATIONS = [
  'Honorable', 'GeneralUnderHonorable', 'OtherThanHonorable',
  'BadConductDischarge', 'DishonorableDischarge', 'Uncharacterized',
] as const

/** The four facts routing needs. Values mirror the .NET RulesEngine enums verbatim. */
export const serviceFactsSchema = z.object({
  branch: z.enum(BRANCHES),
  dischargeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date (YYYY-MM-DD)')
    // The regex alone admits impossible dates like 2024-13-45, which would pass
    // Zod and then blow up on the Postgres date column as an unhandled 500.
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
    }, 'not a real calendar date'),
  characterization: z.enum(CHARACTERIZATIONS),
  wasGeneralCourtMartial: z.boolean(),
})

/**
 * The human-confirmation gate as a code invariant: EXTRACTED facts can never be
 * confirmed, no matter what a caller asks for. Only a manual (veteran-submitted)
 * save may confirm. Routing renders exclusively from confirmed facts, so this is
 * the line that keeps AI extraction out of the deadline-computation path.
 */
export function resolveConfirmed(source: 'manual' | 'extracted', requested: boolean): boolean {
  return source === 'extracted' ? false : requested
}

export type ServiceFacts = z.infer<typeof serviceFactsSchema>

export type ServiceFactsRow = ServiceFacts & {
  id: string
  case_id: string
  source: 'manual' | 'extracted'
  confirmed: boolean
}

export async function getServiceFacts(caseId: string): Promise<ServiceFactsRow | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('service_facts').select('*').eq('case_id', caseId).maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    case_id: data.case_id,
    branch: data.branch,
    dischargeDate: data.discharge_date,
    characterization: data.characterization,
    wasGeneralCourtMartial: data.was_general_court_martial,
    source: data.source,
    confirmed: data.confirmed,
  }
}

export async function saveServiceFacts(
  caseId: string,
  facts: ServiceFacts,
  opts: { source: 'manual' | 'extracted'; confirmed: boolean },
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('service_facts').upsert(
    {
      case_id: caseId,
      owner_id: user.id,
      branch: facts.branch,
      discharge_date: facts.dischargeDate,
      characterization: facts.characterization,
      was_general_court_martial: facts.wasGeneralCourtMartial,
      source: opts.source,
      confirmed: resolveConfirmed(opts.source, opts.confirmed),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}
