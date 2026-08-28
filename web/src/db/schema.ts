import { sql } from 'drizzle-orm'
import {
  pgSchema, uuid, text, boolean, date, integer, timestamp, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core'

/** Everything lives in the app-owned schema; the qavren-db role owns it and nothing else. */
export const recharacter = pgSchema('recharacter')

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}

export const cases = recharacter.table('cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('cases_one_per_owner').on(t.ownerId)])

export const serviceFacts = recharacter.table('service_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }).unique(),
  ownerId: uuid('owner_id').notNull(),
  branch: text('branch').notNull(),
  dischargeDate: date('discharge_date', { mode: 'string' }).notNull(),
  characterization: text('characterization').notNull(),
  wasGeneralCourtMartial: boolean('was_general_court_martial').notNull().default(false),
  source: text('source').notNull().default('manual'),
  confirmed: boolean('confirmed').notNull().default(false),
  ...timestamps,
}, (t) => [
  index('service_facts_owner_idx').on(t.ownerId),
  check('service_facts_branch_check', sql`${t.branch} in ('Army','Navy','MarineCorps','AirForce','SpaceForce','CoastGuard')`),
  // 'GeneralUnderHonorable', not '...Conditions': the .NET RulesEngine enum the
  // routing client passes through verbatim uses the short form, every migration
  // this schema has carried has used it, and src/lib/facts.ts validates against it.
  check('service_facts_characterization_check', sql`${t.characterization} in ('Honorable','GeneralUnderHonorable','OtherThanHonorable','BadConductDischarge','DishonorableDischarge','Uncharacterized')`),
  check('service_facts_source_check', sql`${t.source} in ('manual','extracted')`),
])

export const caseContext = recharacter.table('case_context', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }).unique(),
  ownerId: uuid('owner_id').notNull(),
  conditionCategory: text('condition_category').notNull(),
  mstInvolved: boolean('mst_involved').notNull().default(false),
  treatedInService: boolean('treated_in_service').notNull().default(false),
  hasVaRating: boolean('has_va_rating').notNull().default(false),
  ...timestamps,
}, (t) => [
  index('case_context_owner_idx').on(t.ownerId),
  check('case_context_condition_category_check', sql`${t.conditionCategory} in ('ptsd','tbi','depression_anxiety','adjustment_disorder','other_mh','unsure')`),
])

export const evidenceItems = recharacter.table('evidence_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull(),
  itemType: text('item_type').notNull(),
  status: text('status').notNull().default('needed'),
  notes: text('notes').notNull().default(''),
  ...timestamps,
}, (t) => [
  index('evidence_items_owner_idx').on(t.ownerId),
  uniqueIndex('evidence_items_case_type_key').on(t.caseId, t.itemType),
  check('evidence_items_item_type_check', sql`${t.itemType} in ('dd214','service_treatment_records','va_rating_letter','civilian_mh_records','buddy_statement','nexus_letter','personal_statement')`),
  check('evidence_items_status_check', sql`${t.status} in ('needed','requested','collected','not_applicable')`),
])

export const nexusAnswers = recharacter.table('nexus_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }).unique(),
  ownerId: uuid('owner_id').notNull(),
  q1Condition: text('q1_condition').notNull().default(''),
  q2DuringService: text('q2_during_service').notNull().default(''),
  q3Mitigation: text('q3_mitigation').notNull().default(''),
  q4Outweigh: text('q4_outweigh').notNull().default(''),
  ...timestamps,
}, (t) => [index('nexus_answers_owner_idx').on(t.ownerId)])

export const drafts = recharacter.table('drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  edited: boolean('edited').notNull().default(false),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => [
  index('drafts_owner_idx').on(t.ownerId),
  uniqueIndex('drafts_case_kind_key').on(t.caseId, t.kind),
  check('drafts_kind_check', sql`${t.kind} in ('personal_statement','cover_letter')`),
])

export const aiCredentials = recharacter.table('ai_credentials', {
  ownerId: uuid('owner_id').primaryKey(),
  encryptedKey: text('encrypted_key').notNull(),
  ...timestamps,
})

export const aiUsage = recharacter.table('ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  task: text('task').notNull(),
  model: text('model').notNull(),
  byok: boolean('byok').notNull().default(false),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ai_usage_owner_created_idx').on(t.ownerId, t.createdAt.desc())])

export const entitlements = recharacter.table('entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().unique(),
  kind: text('kind').notNull().default('case_unlock'),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('entitlements_kind_check', sql`${t.kind} in ('case_unlock')`)])

export const pendingCheckouts = recharacter.table('pending_checkouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('pending_checkouts_owner_idx').on(t.ownerId)])
