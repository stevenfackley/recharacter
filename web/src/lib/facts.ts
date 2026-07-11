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

export type ServiceFacts = z.infer<typeof serviceFactsSchema>

/** Field-for-field equality on the four routed facts. */
export function sameFacts(a: ServiceFacts, b: ServiceFacts): boolean {
  return (
    a.branch === b.branch &&
    a.dischargeDate === b.dischargeDate &&
    a.characterization === b.characterization &&
    a.wasGeneralCourtMartial === b.wasGeneralCourtMartial
  )
}

/**
 * Provenance for a confirmation save. `source` records where the VALUES came
 * from, not who vetted them: confirming the saved values untouched preserves
 * their original source (an extraction the veteran vouched for is still an
 * extraction), while editing any field — or having no saved row at all — means
 * the veteran supplied the facts: 'manual'.
 */
export function resolveSource(
  prior: (ServiceFacts & { source: 'manual' | 'extracted' }) | null,
  submitted: ServiceFacts,
): 'manual' | 'extracted' {
  return prior !== null && sameFacts(prior, submitted) ? prior.source : 'manual'
}

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

async function upsertServiceFacts(
  caseId: string,
  facts: ServiceFacts,
  source: 'manual' | 'extracted',
  confirmed: boolean,
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
      source,
      confirmed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}

/**
 * Unconfirmed save (extraction prefill). The human-confirmation gate as a code
 * invariant: this writer CANNOT confirm — only confirmServiceFacts can, and it
 * is called solely from the veteran's own review-form submission. Routing
 * renders exclusively from confirmed facts, so this split is the line that
 * keeps unreviewed AI extraction out of the deadline-computation path.
 */
export async function saveServiceFacts(
  caseId: string,
  facts: ServiceFacts,
  opts: { source: 'manual' | 'extracted' },
): Promise<void> {
  await upsertServiceFacts(caseId, facts, opts.source, false)
}

/**
 * The confirmation gate: the veteran reviewed these values and submitted them.
 * Derives provenance itself (never trusts a caller-supplied label) so an
 * untouched extraction stays 'extracted' while any edit becomes 'manual'.
 */
export async function confirmServiceFacts(caseId: string, facts: ServiceFacts): Promise<void> {
  const prior = await getServiceFacts(caseId)
  await upsertServiceFacts(caseId, facts, resolveSource(prior, facts), true)
}
