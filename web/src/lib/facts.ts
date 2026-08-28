import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { serviceFacts } from '@/db/schema'
import { assertCaseOwned } from '@/lib/cases'

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

/**
 * The text columns are constrained to these unions by check constraints
 * (service_facts_branch_check and friends); drizzle types them as plain `string`,
 * so the row shape callers see is narrowed here rather than at every call site.
 */
type FactsRow = typeof serviceFacts.$inferSelect

function toServiceFactsRow(row: FactsRow): ServiceFactsRow {
  return {
    id: row.id,
    case_id: row.caseId,
    branch: row.branch as ServiceFacts['branch'],
    dischargeDate: row.dischargeDate,
    characterization: row.characterization as ServiceFacts['characterization'],
    wasGeneralCourtMartial: row.wasGeneralCourtMartial,
    source: row.source as 'manual' | 'extracted',
    confirmed: row.confirmed,
  }
}

export async function getServiceFacts(ownerId: string, caseId: string): Promise<ServiceFactsRow | null> {
  const [row] = await getDb()
    .select()
    .from(serviceFacts)
    .where(and(eq(serviceFacts.caseId, caseId), eq(serviceFacts.ownerId, ownerId)))
    .limit(1)
  return row ? toServiceFactsRow(row) : null
}

/**
 * One writer for both entry points. The case-ownership proof happens here, before
 * the upsert: without it a caller could attach a facts row to any case id it
 * guessed. `setWhere` keeps the conflict branch owner-scoped too, so a collision
 * on someone else's case_id updates nothing instead of overwriting their facts.
 *
 * `returning` turns that "updates nothing" from a silent success into a thrown
 * error. A no-op upsert means the row we were told to write is owned by someone
 * else, which the caller must never see as a save.
 */
async function upsertServiceFacts(
  ownerId: string,
  caseId: string,
  facts: ServiceFacts,
  source: 'manual' | 'extracted',
  confirmed: boolean,
): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const columns = {
    branch: facts.branch,
    dischargeDate: facts.dischargeDate,
    characterization: facts.characterization,
    wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
    source,
    confirmed,
    updatedAt: new Date(),
  }
  const rows = await getDb()
    .insert(serviceFacts)
    .values({ caseId, ownerId, ...columns })
    .onConflictDoUpdate({
      target: serviceFacts.caseId,
      set: columns,
      setWhere: eq(serviceFacts.ownerId, ownerId),
    })
    .returning({ id: serviceFacts.id })
  if (!rows.length) throw new Error('service_facts write affected no rows (owner mismatch)')
}

/**
 * Unconfirmed save (extraction prefill). The human-confirmation gate as a code
 * invariant: this writer CANNOT confirm — only confirmServiceFacts can, and it
 * is called solely from the veteran's own review-form submission. Routing
 * renders exclusively from confirmed facts, so this split is the line that
 * keeps unreviewed AI extraction out of the deadline-computation path.
 */
export async function saveServiceFacts(
  ownerId: string,
  caseId: string,
  facts: ServiceFacts,
  source: 'manual' | 'extracted',
): Promise<void> {
  await upsertServiceFacts(ownerId, caseId, facts, source, false)
}

/**
 * The confirmation gate: the veteran reviewed these values and submitted them.
 * Derives provenance itself (never trusts a caller-supplied label) so an
 * untouched extraction stays 'extracted' while any edit becomes 'manual'.
 *
 * No assertCaseOwned here: the prior read is already owner-scoped (a stranger
 * sees null and gets 'manual', which is written to nothing), and the upsert
 * helper proves ownership itself before touching a row. Asserting twice only
 * bought an extra round trip.
 */
export async function confirmServiceFacts(
  ownerId: string,
  caseId: string,
  facts: ServiceFacts,
): Promise<void> {
  const prior = await getServiceFacts(ownerId, caseId)
  await upsertServiceFacts(ownerId, caseId, facts, resolveSource(prior, facts), true)
}
