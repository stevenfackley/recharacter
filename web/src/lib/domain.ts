/**
 * The domain's closed value sets, each written once, with the types derived
 * from them. This module imports nothing, so anything can use it (the AI task
 * registry, a client component, the DB helpers) without pulling in the
 * database.
 *
 * Branch and characterization values mirror the .NET RulesEngine enums
 * verbatim. Every set here is also enforced by a Postgres check constraint
 * (db/schema.ts); those copies belong to other systems and stay where they are.
 */

export const BRANCHES = ['Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard'] as const
export type Branch = (typeof BRANCHES)[number]

export const CHARACTERIZATIONS = [
  'Honorable', 'GeneralUnderHonorable', 'OtherThanHonorable',
  'BadConductDischarge', 'DishonorableDischarge', 'Uncharacterized',
] as const
export type Characterization = (typeof CHARACTERIZATIONS)[number]

export const CONDITION_CATEGORIES = [
  'ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure',
] as const
export type ConditionCategory = (typeof CONDITION_CATEGORIES)[number]

export const EVIDENCE_STATUSES = ['needed', 'requested', 'collected', 'not_applicable'] as const
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number]

export const DRAFT_KINDS = ['personal_statement', 'cover_letter'] as const
export type DraftKind = (typeof DRAFT_KINDS)[number]
