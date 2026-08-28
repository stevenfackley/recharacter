# Plan 09 Execution — Re-platform onto qavren-db + qavren-auth + R2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ReCharacter off its per-app Supabase project onto the fleet convention — Keycloak realm `recharacter` (qavren-auth) for identity, Postgres schema `recharacter` on qavren-db for data (Drizzle, owner-scoped queries instead of RLS), Cloudflare R2 for case documents — and delete the Supabase service-role key problem entirely.

**Architecture:** Every request authenticates through Auth.js v5 wired by `@qavren/auth-next` (Keycloak OIDC code flow + PKCE, encrypted JWT cookie); one `getSessionUser()` replaces 24 `auth.getUser()` sites. Data access goes through `lib/*.ts` modules over Drizzle; **the security invariant that replaces RLS is that every statement carries `owner_id = session user` and every case-scoped write first proves the case belongs to the owner.** Storage is an `ObjectStore` interface (S3/R2 in prod, memory in unit tests, MinIO in CI) with the `{owner}/{case}/{uuid}-{name}` key convention enforced in code. Account deletion runs rows → R2 prefix → Keycloak admin user-delete, failing closed before any data is touched if the Keycloak admin client is unconfigured.

**Tech Stack:** Next.js 16, next-auth 5.0.0-beta.32 + @qavren/auth-next 0.1.2 (public PKCE client `recharacter-web`; confidential flip is one line once auth-next 0.2.0 publishes), drizzle-orm 0.45 + postgres 3.4 (`prepare:false`, transaction pooler :6543 at runtime, session :5432 for migrations), drizzle-kit 0.31, @aws-sdk/client-s3 (R2), zod 4, vitest 4, Postgres 17 + MinIO in CI.

**Platform facts (verified 2026-08-27):**
- Issuer: `https://auth.recharacter.us/realms/recharacter`. Clients: `recharacter-web` (public, PKCE S256, redirect URIs `https://recharacter.us/*`, `http://localhost:3000/*`, post-logout `+`), `recharacter-web-confidential`, `recharacter-admin-svc` (service account, `realm-management: manage-users` only). Registration + password reset on. Keycloak 26.5.5 → `prompt=create` is supported for registration deep-links.
- Realm secrets are staged in `D:\recharacter-credentials-vault-20260802\prod\` (never read them into code/docs).
- qavren-db: schema+role `recharacter` exist on test AND prod (empty). Role search_path = `recharacter, extensions`. Role password was printed once and is NOT in this repo's GitHub secrets → rotate with `pwsh tools/provision-app.ps1 -App recharacter -Env prod -RotatePassword` at cutover. Runtime URL shape: `postgres://recharacter.<projectRef>:<pw>@aws-0-us-east-1.pooler.supabase.com:6543/postgres`; migrations: same with `:5432`.
- Readiness gate: `pwsh C:\Users\steve\projects\qavren-db\tools\preflight-app.ps1 -RepoPath C:\Users\steve\projects\recharacter` must print `READY` (today: `NOT READY`, 5 blocking probes).
- `@qavren/auth-next@0.1.2` (npm) has no `confidential` option (it exists only at qavren-auth HEAD). Use the public client now.

**Review findings folded into this plan** (from the 2026-08-27 full review; F-numbers are referenced in tasks): F2 entitlement insert exposure, F3 unscoped `case_id` reads, F4 >1000-object deletion orphaning, F5 swallowed read errors, F6 reflected `?error=` text, F7 missing `.dockerignore`, F8 PostgREST-specific token-cap heuristic + no global cap, F9 BYOK ciphertext not bound to owner, F10 proxy cookie/return-to/matcher, F12 `grantEntitlement` 23505 ambiguity, F13 no `Cache-Control: no-store` on PII endpoints, F14 client-declared MIME trusted, F15 "documents remain downloadable" copy is false, F16 `getTask` prototype walk, F17 no env fail-fast, F21 no security headers / vitest env globs, F22 no `updated_at` automation, ledger append-only lost with RLS.

---

## File structure

```
web/
  src/
    auth.ts                         Auth.js instance (createAuth composition), exports handlers/auth/signIn/signOut
    proxy.ts                        Next 16 middleware: auth gate + return-to
    lib/env.ts                      zod-validated env (lazy, memoized), requireEnv()
    lib/session.ts                  getSessionUser() / requireSessionUser()
    lib/auth-errors.ts              closed enum of ?error= codes → copy (F6)
    lib/keycloak-admin.ts           client_credentials → DELETE /admin/realms/{realm}/users/{sub}
    lib/storage/object-store.ts     ObjectStore interface + MemoryObjectStore
    lib/storage/s3-object-store.ts  S3ObjectStore (R2 / MinIO), paginated list, batched delete
    lib/storage/index.ts            getObjectStore() singleton from env
    lib/case-documents.ts           key convention, prefix ownership, sniffContentType (F14)
    db/schema.ts                    Drizzle schema, pgSchema('recharacter')
    db/index.ts                     getDb() singleton (postgres-js, prepare:false)
    lib/cases.ts, facts.ts, context.ts, nexus.ts, drafts.ts, evidence-items.ts (new), billing.ts, account.ts
    lib/ai/credentials.ts (new), usage.ts, limits.ts, gateway.ts, crypto.ts (AAD)
    app/api/auth/[...nextauth]/route.ts
    app/(auth)/login|signup         buttons → signIn('keycloak', …)
    app/auth/signout/route.ts       RP-initiated logout
  drizzle/0000_init.sql (+ meta/)   generated + hand-appended ledger guard
  drizzle.config.ts
  scripts/migrate.ts                npm run db:migrate (session URL)
  tests/helpers.ts                  DB/env/store helpers for integration suites
  tests/*.integration.test.ts       owner-scoping suites (ported one-for-one)
compose.dev.yaml                    local Postgres 17 + MinIO
.dockerignore
.github/workflows/ci.yml            web-integration job → Postgres service + MinIO
.github/workflows/deploy.yml        migrate job before deploy; Supabase sync removed
deploy/env.example, web/.env.example, web/Dockerfile
docs/*                              rewritten for the new platform
supabase/                           DELETED (migrations live in web/drizzle now)
```

## Env contract (single source of truth — every task uses these names)

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | prod, CI, tests | postgres-js runtime URL (pooler :6543 on qavren-db) |
| `DATABASE_URL_MIGRATE` | deploy job only | session-mode URL (:5432) for `npm run db:migrate`; falls back to `DATABASE_URL` |
| `AUTH_SECRET` | prod, CI | Auth.js cookie encryption (`openssl rand -base64 32`) — read by Auth.js directly |
| `AUTH_URL` | prod | `https://recharacter.us` (canonical origin behind the tunnel) |
| `QAVREN_AUTH_URL` | default `https://auth.recharacter.us` | Keycloak base (read by @qavren/auth-next too) |
| `QAVREN_REALM` | default `recharacter` | realm / client-id prefix |
| `QAVREN_ADMIN_CLIENT_ID` | default `recharacter-admin-svc` | deletion service account |
| `QAVREN_ADMIN_CLIENT_SECRET` | prod (deletion fails closed without it) | its secret — same value the auth box holds as `RECHARACTER_ADMIN_CLIENT_SECRET` |
| `KEYCLOAK_ADMIN_BASE_URL` | optional | override for the admin API host; defaults to `QAVREN_AUTH_URL` |
| `APP_BASE_URL` | prod | `https://recharacter.us` — Stripe redirects + post-logout redirect |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | prod, CI | object store; endpoint = `S3_ENDPOINT` if set else `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` |
| `S3_ENDPOINT` | CI/dev | MinIO endpoint override |
| `ANTHROPIC_API_KEY`, `AI_KEY_ENCRYPTION_SECRET`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_MANAGED_DAILY_TOKEN_CAP`, `AI_GLOBAL_DAILY_TOKEN_CAP` (new, default 20 000 000), `ROUTING_API_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `TUNNEL_TOKEN` | as before | unchanged semantics |

Dropped: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

---

### Task 0: Branch base and dependencies (orchestrator)

**Files:** `web/package.json`, `web/package-lock.json`, `web/vitest.config.ts`

- [ ] Branch `feat/qavren-replatform` from `main`; merge `fix/ci-ops-hygiene`, `fix/rules-engine-dd-implies-gcm`, `fix/packet-unicode-font` (PRs #63–#65) so the port builds on the lint gate, health probes and font fix.
- [ ] `cd web && npm install @qavren/auth-next@^0.1.2 next-auth@5.0.0-beta.32 drizzle-orm@^0.45.2 postgres@^3.4.9 @aws-sdk/client-s3@^3.1120.0 && npm install -D drizzle-kit@^0.31.10 tsx@^4`
- [ ] `npm uninstall @supabase/ssr @supabase/supabase-js`
- [ ] Add scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx scripts/migrate.ts"`, `"test:integration": "vitest run tests"`.
- [ ] `vitest.config.ts`: split into `test.projects` — `unit` (`src/**/*.test.{ts,tsx}`, jsdom) and `integration` (`tests/**/*.test.ts`, node) (F21; Vitest 4 dropped `environmentMatchGlobs`).
- [ ] Commit: `chore(web): swap supabase for auth-next, drizzle, s3 client`

---

### Task 1: `lib/env.ts` — validated, lazy env

**Files:** Create `web/src/lib/env.ts`, `web/src/lib/env.test.ts`

- [ ] Test:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getEnv, requireEnv, resetEnvForTests } from '@/lib/env'

describe('env', () => {
  beforeEach(() => resetEnvForTests())
  it('applies defaults', () => {
    delete process.env.QAVREN_AUTH_URL
    expect(getEnv().QAVREN_AUTH_URL).toBe('https://auth.recharacter.us')
    expect(getEnv().QAVREN_REALM).toBe('recharacter')
    expect(getEnv().AI_GLOBAL_DAILY_TOKEN_CAP).toBe(20_000_000)
  })
  it('falls back on garbage numeric overrides', () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = 'lots'
    expect(getEnv().AI_RATE_LIMIT_PER_MINUTE).toBe(10)
  })
  it('requireEnv names the missing variable', () => {
    delete process.env.QAVREN_ADMIN_CLIENT_SECRET
    expect(() => requireEnv('QAVREN_ADMIN_CLIENT_SECRET')).toThrow(/QAVREN_ADMIN_CLIENT_SECRET/)
  })
  it('rejects a KEK that is not 32 bytes of base64', () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'short'
    expect(() => getEnv()).toThrow(/AI_KEY_ENCRYPTION_SECRET/)
  })
})
```

- [ ] Implementation:

```ts
import { z } from 'zod'

const positiveInt = (fallback: number) =>
  z.preprocess((v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : undefined
  }, z.number().int().positive().default(fallback))

const base64Kek = z
  .string()
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'AI_KEY_ENCRYPTION_SECRET must be 32 bytes, base64')

const schema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_MIGRATE: z.string().min(1).optional(),
  QAVREN_AUTH_URL: z.string().url().default('https://auth.recharacter.us'),
  QAVREN_REALM: z.string().min(1).default('recharacter'),
  QAVREN_ADMIN_CLIENT_ID: z.string().min(1).default('recharacter-admin-svc'),
  QAVREN_ADMIN_CLIENT_SECRET: z.string().min(1).optional(),
  KEYCLOAK_ADMIN_BASE_URL: z.string().url().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AI_KEY_ENCRYPTION_SECRET: base64Kek.optional(),
  AI_RATE_LIMIT_PER_MINUTE: positiveInt(10),
  AI_MANAGED_DAILY_TOKEN_CAP: positiveInt(2_000_000),
  AI_GLOBAL_DAILY_TOKEN_CAP: positiveInt(20_000_000),
  ROUTING_API_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_PRICE_ID: z.string().min(1).optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

/** Parsed once per process; empty strings count as unset. */
export function getEnv(): Env {
  if (cached) return cached
  const raw: Record<string, string | undefined> = {}
  for (const key of Object.keys(schema.shape)) {
    const v = process.env[key]
    raw[key] = v === '' ? undefined : v
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${issues}`)
  }
  cached = parsed.data
  return cached
}

/** Like getEnv()[key] but throws a message naming the variable when unset. */
export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = getEnv()[key]
  if (v === undefined || v === null) throw new Error(`Missing required environment variable ${key}`)
  return v as NonNullable<Env[K]>
}

export function resetEnvForTests(): void {
  cached = undefined
}
```

- [ ] Run `npx vitest run src/lib/env.test.ts` → PASS. Commit `feat(web): validated lazy env module`.

---

### Task 2: Drizzle schema, client, migration

**Files:** Create `web/src/db/schema.ts`, `web/src/db/index.ts`, `web/drizzle.config.ts`, `web/scripts/migrate.ts`, `web/drizzle/0000_init.sql` (generated), `compose.dev.yaml`; Test `web/tests/schema.integration.test.ts`, `web/tests/helpers.ts`

- [ ] `web/src/db/schema.ts`:

```ts
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
  check('service_facts_characterization_check', sql`${t.characterization} in ('Honorable','GeneralUnderHonorableConditions','OtherThanHonorable','BadConductDischarge','DishonorableDischarge','Uncharacterized')`),
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
}, (t) => [index('case_context_owner_idx').on(t.ownerId)])

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
```

- [ ] `web/src/db/index.ts`:

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { requireEnv } from '@/lib/env'

export type Db = PostgresJsDatabase<typeof schema>

const g = globalThis as unknown as { __recharacterSql?: postgres.Sql; __recharacterDb?: Db }

/**
 * Lazy singleton. `prepare: false` is mandatory on the Supavisor transaction
 * pooler (:6543) qavren-db fronts at runtime; `max` stays small because the
 * pooler multiplexes for us. Survives Next dev HMR via globalThis.
 */
export function getDb(): Db {
  if (g.__recharacterDb) return g.__recharacterDb
  const sql = postgres(requireEnv('DATABASE_URL'), {
    prepare: false,
    max: process.env.NODE_ENV === 'production' ? 10 : 4,
    connect_timeout: 15,
  })
  g.__recharacterSql = sql
  g.__recharacterDb = drizzle(sql, { schema })
  return g.__recharacterDb
}

export async function closeDb(): Promise<void> {
  await g.__recharacterSql?.end({ timeout: 5 })
  g.__recharacterSql = undefined
  g.__recharacterDb = undefined
}
```

- [ ] `web/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['recharacter'],
  migrations: { schema: 'recharacter', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL ?? '' },
})
```

- [ ] `web/scripts/migrate.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Session-mode URL (:5432 on qavren-db). The transaction pooler cannot hold the
// advisory lock / transaction the migrator needs.
const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL_MIGRATE (session URL) or DATABASE_URL')
  process.exit(1)
}
const sql = postgres(url, { max: 1, prepare: false })
try {
  // The bookkeeping table lives INSIDE the app schema: the qavren-db role cannot
  // create the default `drizzle` schema.
  await migrate(drizzle(sql), {
    migrationsFolder: './drizzle',
    migrationsSchema: 'recharacter',
    migrationsTable: '__drizzle_migrations',
  })
  console.log('migrations applied')
} finally {
  await sql.end()
}
```

- [ ] `compose.dev.yaml` (repo root):

```yaml
# Local stack for web/ development and the integration suites.
#   docker compose -f compose.dev.yaml up -d
#   DATABASE_URL=postgres://recharacter:recharacter@127.0.0.1:55433/recharacter
#   S3_ENDPOINT=http://127.0.0.1:9000  R2_ACCESS_KEY_ID=minio  R2_SECRET_ACCESS_KEY=minio12345  R2_BUCKET=recharacter-dev  R2_ACCOUNT_ID=local
name: recharacter-dev
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: recharacter
      POSTGRES_PASSWORD: recharacter
      POSTGRES_DB: recharacter
    ports: ["55433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U recharacter -d recharacter"]
      interval: 5s
      timeout: 3s
      retries: 10
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio12345
    ports: ["9000:9000", "9001:9001"]
```

- [ ] Generate: `cd web && npx drizzle-kit generate --name init`. Then edit `web/drizzle/0000_init.sql`: change `CREATE SCHEMA "recharacter";` to `CREATE SCHEMA IF NOT EXISTS "recharacter";` (qavren-db pre-creates it, owned by the role) and **append** the ledger guard:

```sql
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "recharacter"."ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account deletion is the ONLY sanctioned delete; it runs inside a transaction
  -- that sets this GUC (SET LOCAL). Everything else is refused as 42501 so the
  -- app role cannot rewrite billing or usage history.
  IF TG_OP = 'DELETE' AND current_setting('recharacter.allow_ledger_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER "ai_usage_ledger_guard" BEFORE UPDATE OR DELETE ON "recharacter"."ai_usage" FOR EACH ROW EXECUTE FUNCTION "recharacter"."ledger_guard"();
--> statement-breakpoint
CREATE TRIGGER "entitlements_ledger_guard" BEFORE UPDATE OR DELETE ON "recharacter"."entitlements" FOR EACH ROW EXECUTE FUNCTION "recharacter"."ledger_guard"();
```

- [ ] `web/tests/helpers.ts`:

```ts
import { config } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@/db'
import { MemoryObjectStore } from '@/lib/storage/object-store'

config({ path: '.env.local' })

export const db = () => getDb()
export const freshOwner = () => randomUUID()
export const memoryStore = () => new MemoryObjectStore()

/** Postgres error code of a thrown drizzle/postgres-js error, else undefined. */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export async function allowLedgerDelete<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL recharacter.allow_ledger_delete = 'on'`))
    return run(tx)
  })
}
```

- [ ] `web/tests/schema.integration.test.ts` — proves the constraints the old RLS suites leaned on:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode } from './helpers'
import { cases, serviceFacts, aiUsage, entitlements } from '@/db/schema'

describe('schema invariants', () => {
  it('one case per owner (23505)', async () => {
    const owner = freshOwner()
    await db().insert(cases).values({ ownerId: owner })
    await expect(db().insert(cases).values({ ownerId: owner })).rejects.toSatisfy((e) => pgCode(e) === '23505')
  })
  it('service_facts is unique per case and cascades on case delete', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    const row = { caseId: c.id, ownerId: owner, branch: 'Army', dischargeDate: '2015-01-01', characterization: 'OtherThanHonorable' }
    await db().insert(serviceFacts).values(row)
    await expect(db().insert(serviceFacts).values(row)).rejects.toSatisfy((e) => pgCode(e) === '23505')
    await db().delete(cases).where(eq(cases.id, c.id))
    expect(await db().select().from(serviceFacts).where(eq(serviceFacts.caseId, c.id))).toEqual([])
  })
  it('ai_usage and entitlements refuse UPDATE/DELETE with 42501 outside account deletion', async () => {
    const owner = freshOwner()
    await db().insert(aiUsage).values({ ownerId: owner, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 })
    await db().insert(entitlements).values({ ownerId: owner, stripeSessionId: `cs_${owner}` })
    await expect(db().update(aiUsage).set({ inputTokens: 0 }).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(aiUsage).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(entitlements).where(eq(entitlements.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect((await db().select().from(aiUsage).where(eq(aiUsage.ownerId, owner))).length).toBe(1)
  })
})
```

- [ ] Run locally: `docker compose -f compose.dev.yaml up -d`, `cd web && DATABASE_URL=postgres://recharacter:recharacter@127.0.0.1:55433/recharacter npm run db:migrate && npx vitest run tests/schema.integration.test.ts` → PASS. Commit `feat(db): drizzle schema for the recharacter schema, migrator, dev stack`.

---

### Task 3: Object store (R2/S3 + memory) and case-document helpers

**Files:** Create `web/src/lib/storage/object-store.ts`, `web/src/lib/storage/s3-object-store.ts`, `web/src/lib/storage/index.ts`, `web/src/lib/case-documents.ts`; Tests `web/src/lib/storage/object-store.test.ts`, `web/src/lib/case-documents.test.ts`, `web/tests/storage-scoping.integration.test.ts`

- [ ] `object-store.ts`:

```ts
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  /** Every key under the prefix, fully paginated (F4). */
  list(prefix: string): Promise<string[]>
  remove(keys: string[]): Promise<void>
}

export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, { body: Uint8Array; contentType: string }>()
  async put(key: string, body: Uint8Array, contentType: string) { this.objects.set(key, { body, contentType }) }
  async get(key: string) { return this.objects.get(key)?.body ?? null }
  async list(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort() }
  async remove(keys: string[]) { for (const k of keys) this.objects.delete(k) }
}
```

- [ ] `s3-object-store.ts`:

```ts
import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, NoSuchKey,
} from '@aws-sdk/client-s3'
import type { ObjectStore } from './object-store'

export type S3ObjectStoreOptions = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3ObjectStore implements ObjectStore {
  private client: S3Client
  private bucket: string
  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket
    this.client = new S3Client({
      region: 'auto',
      endpoint: opts.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    })
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }))
  }
  async get(key: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return out.Body ? await out.Body.transformToByteArray() : null
    } catch (err) {
      if (err instanceof NoSuchKey) return null
      throw err
    }
  }
  async list(prefix: string) {
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return keys
  }
  async remove(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000)
      const out = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }))
      if (out.Errors?.length) throw new Error(`object delete failed for ${out.Errors.length} keys`)
    }
  }
}
```

- [ ] `storage/index.ts`:

```ts
import { getEnv, requireEnv } from '@/lib/env'
import type { ObjectStore } from './object-store'
import { S3ObjectStore } from './s3-object-store'

let store: ObjectStore | undefined

/** Production store from env (R2, or MinIO via S3_ENDPOINT). Tests inject their own. */
export function getObjectStore(): ObjectStore {
  if (store) return store
  const env = getEnv()
  const endpoint = env.S3_ENDPOINT ?? `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`
  store = new S3ObjectStore({
    endpoint,
    bucket: requireEnv('R2_BUCKET'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  })
  return store
}

export type { ObjectStore }
```

- [ ] `case-documents.ts` (F14 sniffing; ownership by prefix):

```ts
import { randomUUID } from 'node:crypto'
import type { ObjectStore } from '@/lib/storage/object-store'

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
export type DocumentType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'

/** Magic-byte detection; the multipart Content-Type is client-controlled and ignored. */
export function sniffContentType(bytes: Uint8Array): DocumentType | null {
  const b = bytes
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

export function ownerPrefix(ownerId: string): string { return `${ownerId}/` }

export function documentKey(ownerId: string, caseId: string, originalName: string): string {
  const safeName = originalName.replace(/[^\w.\-]/g, '_').slice(0, 120) || 'document'
  return `${ownerPrefix(ownerId)}${caseId}/${randomUUID()}-${safeName}`
}

export class ForeignObjectError extends Error {}

/** The code-level replacement for storage RLS: a key must sit under the caller's prefix. */
export function assertOwnedKey(ownerId: string, key: string): void {
  if (!key.startsWith(ownerPrefix(ownerId))) throw new ForeignObjectError('object does not belong to this account')
}

export async function putCaseDocument(store: ObjectStore, ownerId: string, caseId: string, name: string, bytes: Uint8Array, contentType: DocumentType): Promise<string> {
  const key = documentKey(ownerId, caseId, name)
  assertOwnedKey(ownerId, key)
  await store.put(key, bytes, contentType)
  return key
}

export async function getCaseDocument(store: ObjectStore, ownerId: string, key: string): Promise<Uint8Array | null> {
  assertOwnedKey(ownerId, key)
  return store.get(key)
}

export async function listOwnerDocuments(store: ObjectStore, ownerId: string): Promise<string[]> {
  return store.list(ownerPrefix(ownerId))
}

/** Deletes every object under the owner's prefix and PROVES the prefix is empty afterwards (F4). */
export async function removeOwnerDocuments(store: ObjectStore, ownerId: string): Promise<number> {
  const keys = await listOwnerDocuments(store, ownerId)
  if (keys.length) await store.remove(keys)
  const left = await listOwnerDocuments(store, ownerId)
  if (left.length) throw new Error(`${left.length} objects survived deletion sweep`)
  return keys.length
}
```

- [ ] Unit tests: `sniffContentType` on the four magic prefixes + `text/plain` bytes → null; `documentKey` strips `../` and slashes, always starts with `${owner}/${case}/`; `assertOwnedKey` throws `ForeignObjectError` for another owner's key; `MemoryObjectStore` list/remove round-trip; `removeOwnerDocuments` on memory store returns count and leaves other owners untouched.
- [ ] `tests/storage-scoping.integration.test.ts` — against the S3 store when `S3_ENDPOINT` is set (skip with `describe.skipIf(!process.env.S3_ENDPOINT)`): create the bucket if missing (`CreateBucketCommand`, ignore `BucketAlreadyOwnedByYou`), then: Alice `putCaseDocument` → `getCaseDocument` round-trips bytes; Bob `getCaseDocument(store, bob, aliceKey)` throws `ForeignObjectError`; Bob `removeOwnerDocuments` leaves Alice's object; 1,200 tiny objects under Alice → `removeOwnerDocuments` returns 1200 and `list` is empty (pagination beyond one page).
- [ ] Run unit + integration (MinIO from `compose.dev.yaml`). Commit `feat(storage): object store over R2/S3 with owner-prefix scoping`.

---

### Task 4: Keycloak admin client (account deletion backend)

**Files:** Create `web/src/lib/keycloak-admin.ts`, `web/src/lib/keycloak-admin.test.ts`

- [ ] Implementation (port of trailtold's `deleter.py` contract):

```ts
import { getEnv, requireEnv } from '@/lib/env'

export class KeycloakAdminUnavailable extends Error {}

type Fetch = typeof fetch

export type KeycloakAdmin = {
  /** Proves configuration + credentials BEFORE any data is deleted. */
  getToken(): Promise<string>
  /** 204/200 → deleted; 404 → treated as already deleted (logged loudly); anything else throws. */
  deleteUser(sub: string, token: string): Promise<void>
}

export function keycloakAdminConfigured(): boolean {
  return Boolean(getEnv().QAVREN_ADMIN_CLIENT_SECRET)
}

export function createKeycloakAdmin(fetchImpl: Fetch = fetch): KeycloakAdmin {
  const env = getEnv()
  if (!env.QAVREN_ADMIN_CLIENT_SECRET) {
    throw new KeycloakAdminUnavailable('QAVREN_ADMIN_CLIENT_SECRET is not set; account deletion is disabled')
  }
  const base = (env.KEYCLOAK_ADMIN_BASE_URL ?? env.QAVREN_AUTH_URL).replace(/\/+$/, '')
  const realm = env.QAVREN_REALM
  const clientId = env.QAVREN_ADMIN_CLIENT_ID
  const clientSecret = requireEnv('QAVREN_ADMIN_CLIENT_SECRET')

  return {
    async getToken() {
      const res = await fetchImpl(`${base}/realms/${realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
        redirect: 'manual',
      })
      if (res.status !== 200) throw new Error(`keycloak token endpoint returned ${res.status}`)
      const json = (await res.json()) as { access_token?: string }
      if (!json.access_token) throw new Error('keycloak token response had no access_token')
      return json.access_token
    },
    async deleteUser(sub, token) {
      const res = await fetchImpl(`${base}/admin/realms/${realm}/users/${encodeURIComponent(sub)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
      })
      if (res.status === 204 || res.status === 200) return
      if (res.status === 404) {
        // A wrong realm/base URL ALSO 404s on every call — never let this be silent.
        console.error(`keycloak user ${sub} not found in realm ${realm} at ${base}; treating as already deleted`)
        return
      }
      throw new Error(`keycloak user delete returned ${res.status}`)
    },
  }
}
```

- [ ] Tests with a stub `fetch` (record calls): token request body has `grant_type=client_credentials` and the client id; non-200 token → throws; delete 204 → resolves; 404 → resolves and `console.error` called; 403 → throws; missing secret → `createKeycloakAdmin` throws `KeycloakAdminUnavailable`; base URL prefers `KEYCLOAK_ADMIN_BASE_URL`. Commit `feat(auth): keycloak admin client for account deletion`.

---

### Task 5: Auth.js + @qavren/auth-next wiring, session helper, proxy, login/signup/signout

**Files:** Create `web/src/auth.ts`, `web/src/lib/session.ts`, `web/src/lib/auth-errors.ts`, `web/src/app/api/auth/[...nextauth]/route.ts`; Modify `web/src/proxy.ts`, `web/src/proxy.test.ts`, `web/src/app/(auth)/login/{page,actions}.tsx|ts`, `web/src/app/(auth)/signup/{page,actions}.tsx|ts`, `web/src/app/auth/signout/route.ts`, `web/src/app/layout.tsx` (if it renders auth links); Delete `web/src/lib/supabase/*`.

- [ ] `web/src/auth.ts`:

```ts
import NextAuth, { type NextAuthConfig } from 'next-auth'
import { buildAuthConfig } from '@qavren/auth-next'

declare module 'next-auth' {
  interface Session {
    /** Keycloak ID token, kept ONLY for RP-initiated logout. Server-side use only — never pass a session object to a client component. */
    idToken?: string
  }
}

const realm = process.env.QAVREN_REALM || 'recharacter'
const baseUrl = process.env.QAVREN_AUTH_URL || 'https://auth.recharacter.us'

// buildAuthConfig spreads overrides LAST, so passing `callbacks` there would
// replace the SDK's role/sub callbacks. Compose explicitly instead.
const base = buildAuthConfig({ realm, baseUrl, trustHost: true, pages: { signIn: '/login' } })

const config: NextAuthConfig = {
  ...base,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  callbacks: {
    async jwt(params) {
      const token = (await base.callbacks!.jwt!(params)) ?? params.token
      if (params.account?.id_token) token.idToken = params.account.id_token
      return token
    },
    async session(params) {
      const session = await base.callbacks!.session!(params)
      if (session.user && params.token.sub) session.user.id = params.token.sub
      session.idToken = typeof params.token.idToken === 'string' ? params.token.idToken : undefined
      return session
    },
  },
}

export const { handlers, auth, signIn, signOut } = NextAuth(config)
```

  Note: `session.user.id` is the Keycloak `sub` (a UUID) — it is `owner_id` everywhere. The public client `recharacter-web` is used; when `@qavren/auth-next` ≥ 0.2.0 publishes, add `confidential: true` and `QAVREN_CLIENT_SECRET` to switch to `recharacter-web-confidential`.

- [ ] `web/src/app/api/auth/[...nextauth]/route.ts`: `import { handlers } from '@/auth'; export const { GET, POST } = handlers`.

- [ ] `web/src/lib/session.ts`:

```ts
import { redirect } from 'next/navigation'
import { auth } from '@/auth'

export type SessionUser = { id: string; email: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The one place session identity is read. `id` is the Keycloak `sub`. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth()
  const id = session?.user?.id
  if (!id || !UUID.test(id)) return null
  return { id, email: session!.user!.email ?? null }
}

/** Pages/actions: redirect to login (with return-to) when unauthenticated. */
export async function requireSessionUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  return user
}

/** Only same-origin, absolute-path targets survive; anything else goes to /case. */
export function safeNext(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : '/case'
}
```

- [ ] `web/src/lib/auth-errors.ts` (F6 — codes, never text, travel in URLs):

```ts
export const AUTH_ERRORS = {
  signin_failed: 'Sign-in did not complete. Please try again.',
  session_expired: 'Your session expired. Sign in again to continue.',
  deletion_unavailable: 'Account deletion is temporarily unavailable. Nothing was removed.',
} as const
export type AuthErrorCode = keyof typeof AUTH_ERRORS
export function authErrorMessage(code: unknown): string | null {
  return typeof code === 'string' && code in AUTH_ERRORS ? AUTH_ERRORS[code as AuthErrorCode] : null
}
```

- [ ] `web/src/proxy.ts`:

```ts
import { NextResponse } from 'next/server'
import { auth } from '@/auth'

const PROTECTED = ['/case', '/settings', '/api/ai', '/api/packet', '/api/account']

export default auth((req) => {
  const { pathname, search } = req.nextUrl
  const needsAuth = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'))
  if (!needsAuth || req.auth?.user?.id) return NextResponse.next()
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  const login = new URL('/login', req.nextUrl.origin)
  login.searchParams.set('next', pathname + search)
  return NextResponse.redirect(login)
})

export const config = {
  // Skip static assets, Auth.js's own routes, the health probe, and anything with a file extension (F10).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/health|.*\\..*).*)'],
}
```

  `proxy.test.ts`: mock `@/auth` so `auth(fn)` returns `fn` and inject `req.auth`; assert: unauthenticated `/case/nexus?x=1` → 307 to `/login?next=%2Fcase%2Fnexus%3Fx%3D1`; unauthenticated `/api/packet` → 401 JSON; authenticated `/case` → next(); `/` and `/privacy` pass without auth.

- [ ] Login/signup actions (`(auth)/login/actions.ts`, `(auth)/signup/actions.ts`):

```ts
'use server'
import { signIn } from '@/auth'
import { safeNext } from '@/lib/session'

export async function loginAction(formData: FormData) {
  await signIn('keycloak', { redirectTo: safeNext(formData.get('next')) })
}
```

```ts
'use server'
import { signIn } from '@/auth'
import { safeNext } from '@/lib/session'

/** Keycloak ≥26.1 honours the OIDC `prompt=create` hint and opens the registration form. */
export async function signupAction(formData: FormData) {
  await signIn('keycloak', { redirectTo: safeNext(formData.get('next')) }, { prompt: 'create' })
}
```

  Pages keep the existing "records office" layout and copy but replace the email/password fields with a single submit button (`Sign in` / `Create your account`), a hidden `next` input from `searchParams.next`, and render `authErrorMessage(searchParams.error)` in the existing `role="alert"` element. Mention on the signup page that password reset now exists ("Forgot your password? Use the link on the sign-in page").

- [ ] `web/src/app/auth/signout/route.ts` (RP-initiated logout; shared-computer PII means the Keycloak SSO cookie must die too):

```ts
import { NextResponse } from 'next/server'
import { issuerFor } from '@qavren/auth-next'
import { auth, signOut } from '@/auth'
import { getEnv } from '@/lib/env'

export async function POST(req: Request) {
  const env = getEnv()
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(env.APP_BASE_URL).origin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const session = await auth()
  await signOut({ redirect: false })
  const end = new URL(`${issuerFor(env.QAVREN_REALM, env.QAVREN_AUTH_URL)}/protocol/openid-connect/logout`)
  end.searchParams.set('post_logout_redirect_uri', `${env.APP_BASE_URL}/login`)
  if (session?.idToken) end.searchParams.set('id_token_hint', session.idToken)
  else end.searchParams.set('client_id', `${env.QAVREN_REALM}-web`)
  return NextResponse.redirect(end, 303)
}
```

- [ ] Delete `web/src/lib/supabase/` (all four files). Run `npx tsc --noEmit` — expect errors only in the not-yet-ported modules (Tasks 6–8). Commit `feat(auth): keycloak sign-in via @qavren/auth-next, single session helper, RP logout`.

---

### Task 6: Data modules over Drizzle (owner-scoped) + ported isolation suites

**Files:** Modify `web/src/lib/cases.ts`, `facts.ts`, `context.ts`, `nexus.ts`, `drafts.ts`, `billing.ts`, `ai/usage.ts`, `ai/limits.ts`, `ai/gateway.ts`, `ai/crypto.ts`, `ai/provider.ts` (if it takes the key), `ai/tasks.ts` (`getTask` F16); Create `web/src/lib/evidence-items.ts`, `web/src/lib/ai/credentials.ts`; Rewrite `web/tests/{cases,service-facts-scoping,evidence-scoping,nexus-scoping,ai-scoping,entitlements-scoping}.integration.test.ts` (delete the old `*-rls*` files); update the affected unit tests (`facts.test.ts`, `drafts.test.ts`, `nexus.test.ts`, `billing.test.ts`, `ai/gateway.test.ts`, `ai/crypto.test.ts`).

**Signatures (fixed — later tasks depend on them):**

```ts
// cases.ts
export class CaseNotFoundError extends Error {}
export async function getOrCreateCase(ownerId: string): Promise<{ id: string }>
export async function assertCaseOwned(ownerId: string, caseId: string): Promise<void>   // throws CaseNotFoundError
// facts.ts (pure helpers sameFacts/resolveSource/resolveConfirmed unchanged)
export async function getServiceFacts(ownerId: string, caseId: string): Promise<ServiceFactsRow | null>
export async function saveServiceFacts(ownerId: string, caseId: string, facts: ServiceFacts, source: 'manual' | 'extracted'): Promise<void>
export async function confirmServiceFacts(ownerId: string, caseId: string, facts: ServiceFacts): Promise<void>
// context.ts
export async function getCaseContext(ownerId: string, caseId: string): Promise<CaseContext | null>
export async function saveCaseContext(ownerId: string, caseId: string, ctx: CaseContext): Promise<void>
// evidence-items.ts (NEW — folds the five inline evidence_items queries)
export async function getEvidenceStatuses(ownerId: string, caseId: string): Promise<EvidenceStatusMap>
export async function setEvidenceStatus(ownerId: string, caseId: string, itemType: EvidenceType, status: EvidenceStatus): Promise<void>
// nexus.ts
export async function getNexusAnswers(ownerId: string, caseId: string): Promise<NexusAnswers | null>
export async function saveNexusAnswer(ownerId: string, caseId: string, key: KurtaKey, text: string): Promise<void>
// drafts.ts
export async function getDraft(ownerId: string, caseId: string, kind: DraftKind): Promise<Draft | null>
export async function saveGeneratedDraft(ownerId: string, caseId: string, kind: DraftKind, content: string): Promise<void>
export async function saveEditedDraft(ownerId: string, caseId: string, kind: DraftKind, content: string): Promise<void>
// billing.ts
export async function isEntitled(ownerId: string): Promise<boolean>                       // entitlement row OR BYOK credential
export async function recordPendingCheckout(ownerId: string, sessionId: string): Promise<void>
export async function listPendingCheckouts(ownerId: string): Promise<string[]>
export async function grantEntitlement(ownerId: string, sessionId: string): Promise<'granted' | 'already_entitled'>
export async function clearPendingCheckout(ownerId: string, sessionId: string): Promise<void>
// ai/credentials.ts (NEW)
export async function getEncryptedKey(ownerId: string): Promise<string | null>
export async function saveEncryptedKey(ownerId: string, ciphertext: string): Promise<void>
export async function deleteEncryptedKey(ownerId: string): Promise<void>
export async function credentialCreatedAt(ownerId: string): Promise<Date | null>
// ai/usage.ts
export async function recordUsage(ownerId: string, u: { task: string; model: string; byok: boolean; inputTokens: number; outputTokens: number }): Promise<void>
export async function usageTotals(ownerId: string): Promise<{ inputTokens: number; outputTokens: number; calls: number }>
// ai/limits.ts
export async function checkAiLimits(ownerId: string, byok: boolean): Promise<AiLimitDecision>
// ai/gateway.ts
export async function executeAiTask(ownerId: string, taskName: string, input: unknown): Promise<AiTaskResult>
// ai/crypto.ts (F9: AAD binds ciphertext to its owner; fresh-provision cutover means no legacy ciphertexts)
export function encryptSecret(plaintext: string, kekBase64: string, aad: string): string
export function decryptSecret(payloadBase64: string, kekBase64: string, aad: string): string
```

**Rules for every function above (this IS the RLS replacement):**
1. Every `select`/`update`/`delete` has `eq(t.ownerId, ownerId)` in its `where` — even when `caseId` is also present.
2. Every case-scoped write calls `await assertCaseOwned(ownerId, caseId)` first, then upserts with `onConflictDoUpdate({ target, set, setWhere: eq(t.ownerId, ownerId) })`.
3. Drizzle throws on failure — **do not** catch-and-return-null (F5). Only `recordUsage` keeps its swallow-and-log behaviour (usage bookkeeping must never fail a request).
4. `nexus.saveNexusAnswer` builds `set` from the ONE column being saved (`{ [column]: text, updatedAt: new Date() }`) — a full-object `set` would blank the other three answers.
5. `grantEntitlement`: `insert(...).onConflictDoNothing({ target: entitlements.ownerId }).returning()` → if a row came back → `'granted'`; else select by `ownerId` — if it exists → `'already_entitled'` (and log at warn level with both session ids: F12 "second paid session" case); if it doesn't (unique on `stripeSessionId` collided) → throw. Then `clearPendingCheckout(ownerId, sessionId)`.
6. `limits.ts` (F8): two SQL aggregates, both `where(and(eq(ownerId), gte(createdAt, since)))`:
   - per-minute: `select({ n: count() })` vs `env.AI_RATE_LIMIT_PER_MINUTE`
   - daily managed: `select({ n: count(), tokens: sql<number>\`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)\` })` with `eq(aiUsage.byok, false)`; over-cap if `tokens >= AI_MANAGED_DAILY_TOKEN_CAP` **or `n >= 1000`** (the explicit form of the old "truncated page" rule)
   - NEW global daily managed ceiling: same aggregate WITHOUT the owner predicate vs `AI_GLOBAL_DAILY_TOKEN_CAP` → error `'The shared AI capacity for today is used up — continue with your own API key in AI settings, or try tomorrow'`.
   - Lookups still fail OPEN with `console.error` (spend protection, not security), exactly like today.
7. `gateway.ts`: `executeAiTask(ownerId, …)` reads the credential via `getEncryptedKey`, passes `ownerId` as AAD to `decryptSecret`; a decrypt failure returns `{ ok: false, status: 503, error: 'Your saved API key could not be read — re-enter it in AI settings', byokKeyRejected: true }`.
8. `tasks.ts` `getTask`: `return Object.hasOwn(TASKS, name) ? TASKS[name as keyof typeof TASKS] : undefined` (F16).
9. (Review round, 2026-08-27) `cases` carries `unique (id, owner_id)` and every case-scoped child table carries a composite FK `(case_id, owner_id) → cases(id, owner_id)`, so an owner/case mismatch is unrepresentable; every upsert also ends with `.returning()` and throws when zero rows changed, so a `setWhere` miss can never masquerade as a successful save.
10. (Review round) The per-minute AI limit counts **attempts** (`ai_attempts`, inserted before `checkAiLimits`), not completed calls — concurrent bursts and provider-failure loops are bounded. Daily token caps still read `ai_usage`; the global ceiling uses a partial index on `ai_usage (created_at) where byok = false`, and sums are cast `::bigint`.

**Integration suites (one invariant per `it`, all against the data-module functions, two synthetic owners `alice`/`bob` = `freshOwner()`):**
- `cases`: `getOrCreateCase(alice)` twice → same id, one row; `getOrCreateCase(bob)` → different id; `assertCaseOwned(bob, aliceCase)` rejects `CaseNotFoundError`.
- `service-facts-scoping`: Alice save+get round-trip; `getServiceFacts(bob, aliceCase)` → `null`; `saveServiceFacts(bob, aliceCase, …)` rejects `CaseNotFoundError` and Alice's row is unchanged; `confirmServiceFacts` cannot be reached with `source:'extracted'` + `confirmed:true` from `saveServiceFacts` (existing `resolveConfirmed` invariant); `saveServiceFacts` twice on one case updates in place (no 23505 leak).
- `evidence-scoping`: context + evidence items: Bob reads `{}`/`null`; Bob's `setEvidenceStatus` on Alice's case rejects; Alice's status update sticks; second `setEvidenceStatus` same type updates not duplicates.
- `nexus-scoping`: saving `q2` leaves `q1` intact (rule 4); Bob reads `null`; Bob's save rejects; drafts: Bob's `saveEditedDraft` on Alice's case rejects and Alice's content is unchanged; `getDraft(bob, aliceCase, kind)` → `null`.
- `ai-scoping`: `saveEncryptedKey`/`getEncryptedKey` isolated per owner; `decryptSecret(aliceCiphertext, kek, bob)` throws (AAD); `recordUsage` then `usageTotals(bob)` → zeros; `checkAiLimits` denies after `AI_RATE_LIMIT_PER_MINUTE` records in the window (set env to 2 for the test, `resetEnvForTests()`), and denies at the global cap (set `AI_GLOBAL_DAILY_TOKEN_CAP=1`).
- `entitlements-scoping`: `isEntitled(alice)` false → `grantEntitlement(alice, 'cs_a1')` → `'granted'` → true; `grantEntitlement(alice, 'cs_a2')` → `'already_entitled'`; `isEntitled(bob)` still false; direct `db().update(entitlements)` rejects 42501; `recordPendingCheckout` + `listPendingCheckouts(bob)` → `[]`; `clearPendingCheckout(bob, aliceSession)` leaves Alice's pending row.
- Each suite: `afterAll(closeDb)`.

- [ ] Port one module + its suite at a time; run `npx vitest run tests/<suite>` after each; commit per module (`feat(data): port <module> to drizzle with owner scoping`).

---

### Task 7: Call-site rewiring (actions, pages, routes) and remaining review fixes

**Files:** Modify `web/src/app/api/account/export/route.ts`, `api/ai/[task]/route.ts`, `api/packet/route.ts`, `case/{draft,evidence,intake,nexus,upgrade}/actions.ts`, `case/{evidence,packet,upgrade,intake,draft,nexus}/page.tsx`, `case/page.tsx`, `settings/ai/{actions.ts,page.tsx}`, `settings/data/{actions.ts,page.tsx}`, `web/next.config.ts`; their tests.

Mechanical substitutions:
- `const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) redirect('/login')` → `const user = await requireSessionUser('<this page path>')` in actions/pages; in route handlers `const user = await getSessionUser(); if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })`.
- Every data call gains `user.id` as first arg; inline `supabase.from('evidence_items')…` → `getEvidenceStatuses`/`setEvidenceStatus`; inline `entitlements`/`ai_credentials` reads on `upgrade/page.tsx` and `settings/ai/page.tsx` → `isEntitled` / `credentialCreatedAt` / `usageTotals`.
- `executeAiTask(supabase, user.id, …)` → `executeAiTask(user.id, …)`.
- `intake/actions.ts`: read bytes first, `const type = sniffContentType(bytes)`; reject when `null` (F14) with code `unsupported_file`; `putCaseDocument(getObjectStore(), user.id, c.id, file.name, bytes, type)`; pass `type` (not `file.type`) to the extraction task.
- F6: every `redirect('/…?error=' + encodeURIComponent('<text>'))` becomes `redirect('/…?error=<code>')` with the code added to a per-page `const ERRORS = { … } as const` map at the top of the page file, and the page renders `ERRORS[code] ?? null`. Never render `params.error` directly.
- F13: `api/account/export` and `api/packet` responses add `'Cache-Control': 'private, no-store'` and `Vary: Cookie`.
- F15: `settings/data/page.tsx` copy: replace "remain downloadable from your case until you delete them" with "are kept only to run extraction; the export lists their file names, and account deletion removes them".
- F21: `next.config.ts` `headers()` → for `/(.*)`: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `upgrade/page.tsx` keeps the GET verification (Stripe returns via GET) but `verifySession` now calls `grantEntitlement(user.id, sessionId)` and treats `'already_entitled'` as success.
- Remove the `web/Dockerfile` `NEXT_PUBLIC_SUPABASE_*` build placeholders; add `.dockerignore` at repo root (F7):

```
**/node_modules
**/.next
**/.env*
!**/.env.example
.git
.claude
**/bin
**/obj
```

- [ ] After each file: `npx tsc --noEmit` shrinks; unit tests in `src/**` updated to the new signatures (mock `@/lib/session` and the data modules instead of a supabase client). Commit in logical groups (`refactor(web): route <area> through session + data modules`).

---

### Task 8: Account export + deletion rewrite

**Files:** Modify `web/src/lib/account.ts`, `web/src/lib/account.test.ts`, `web/src/app/settings/data/actions.ts`; Rewrite `web/tests/account-deletion.integration.test.ts`.

```ts
// account.ts
export async function collectExport(ownerId: string, store: ObjectStore): Promise<AccountExport>
//   rows: cases, service_facts, case_context, evidence_items, nexus_answers, drafts, ai_usage, entitlements(kind, created_at), pending_checkouts(stripe_session_id, created_at), ai_credentials → { present: boolean, created_at } ONLY (ciphertext never leaves)
//   uploadedDocuments: listOwnerDocuments(store, ownerId)
export class DeletionUnavailableError extends Error {}
export async function deleteAccountData(ownerId: string, deps: { store: ObjectStore; admin?: KeycloakAdmin }): Promise<{ rowsByTable: Record<string, number>; objects: number }>
```

Order inside `deleteAccountData` (fails closed BEFORE touching data):
1. `const admin = deps.admin ?? createKeycloakAdmin()` — throws `KeycloakAdminUnavailable` → rethrow as `DeletionUnavailableError`.
2. `const token = await admin.getToken()` (bad credentials surface here, with nothing deleted).
3. `db().transaction`: `SET LOCAL recharacter.allow_ledger_delete = 'on'` (via `sql.raw`), then delete `aiUsage`, `entitlements`, `pendingCheckouts`, `aiCredentials`, `cases` (cascades the five case-scoped tables) — each `where(eq(t.ownerId, ownerId))`, collecting `returning({ id })` counts.
4. `removeOwnerDocuments(store, ownerId)` (verifies empty).
5. `admin.deleteUser(ownerId, token)`.

`settings/data/actions.ts` `deleteAccount`: `requireSessionUser`, confirm phrase check as today, `deleteAccountData(user.id, { store: getObjectStore() })`; on `DeletionUnavailableError` → `redirect('/settings/data?error=deletion_unavailable')`; on success → `signOut({ redirect: false })` then redirect to `/login?deleted=1` (Keycloak session is gone with the user).

Integration suite (`account-deletion.integration.test.ts`, node env): seed Alice and Bob with one row in every owner table + one object each (memory store) + an entitlement; stub admin `{ getToken: async () => 't', deleteUser: vi.fn() }`; assert: export contains every table, the BYOK ciphertext string appears nowhere in `JSON.stringify(export)`, `pending_checkouts` is included; after `deleteAccountData(alice)`: 0 rows for Alice and 1 for Bob in **all ten** tables (`entitlements`/`pending_checkouts` included), Alice's prefix empty, Bob's object intact, `deleteUser` called once with Alice's id; an admin whose `getToken` throws leaves every row and object untouched.

- [ ] Commit `feat(account): export and one-click deletion over drizzle, R2 and keycloak admin`.

---

### Task 9: CI and deploy

**Files:** Modify `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `deploy/env.example`, `web/.env.example`; Delete `supabase/`.

- [ ] `ci.yml` `web` job env: replace the two Supabase dummies with `AUTH_SECRET: ci-dummy-secret-at-least-32-bytes-long-000`, `DATABASE_URL: postgres://x:y@127.0.0.1:5432/x` (build never connects). Set `node-version: 26` in both web jobs (matches the runtime image).
- [ ] Replace `web-integration`:

```yaml
  web-integration:
    name: Web (owner-scoping integration, Postgres + MinIO)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:17-alpine
        env: { POSTGRES_USER: recharacter, POSTGRES_PASSWORD: recharacter, POSTGRES_DB: recharacter }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U recharacter -d recharacter" --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgres://recharacter:recharacter@127.0.0.1:5432/recharacter
      S3_ENDPOINT: http://127.0.0.1:9000
      R2_ACCOUNT_ID: local
      R2_ACCESS_KEY_ID: minio
      R2_SECRET_ACCESS_KEY: minio12345
      R2_BUCKET: recharacter-ci
      AUTH_SECRET: ci-dummy-secret-at-least-32-bytes-long-000
      APP_BASE_URL: http://localhost:3000
      AI_KEY_ENCRYPTION_SECRET: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 26, cache: npm, cache-dependency-path: web/package-lock.json }
      - name: Start MinIO
        run: |
          docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 minio/minio server /data
          for i in $(seq 1 30); do curl -fsS http://127.0.0.1:9000/minio/health/live && break; sleep 1; done
      - name: Install
        working-directory: web
        run: npm ci
      - name: Migrate
        working-directory: web
        run: npm run db:migrate
      - name: Full test suite (incl. owner-scoping isolation)
        working-directory: web
        run: npx vitest run
```

- [ ] `deploy.yml`: delete the `SUPABASE_SERVICE_ROLE_KEY` sync lines in the SSH step; add a `migrate` job between the builds and `deploy` (`needs: [build-web, build-routing]`, `deploy` needs `migrate`):

```yaml
  migrate:
    name: Migrate qavren-db (recharacter schema)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [build-web, build-routing]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 26, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
        working-directory: web
      - name: Apply migrations over the session pooler
        working-directory: web
        env:
          DATABASE_URL_MIGRATE: ${{ secrets.DATABASE_URL_MIGRATE }}
        run: |
          test -n "$DATABASE_URL_MIGRATE" || { echo "DATABASE_URL_MIGRATE secret is not set — refusing to deploy against an unmigrated schema"; exit 1; }
          npm run db:migrate
```

- [ ] `web/.env.example` and `deploy/env.example`: rewrite to the env contract table above (comments per var; note `QAVREN_ADMIN_CLIENT_SECRET` "same value as the auth box's RECHARACTER_ADMIN_CLIENT_SECRET — rotate together"; `AUTH_SECRET` generation command).
- [ ] `git rm -r supabase/`. Commit `ci: replace the local-supabase job with postgres+minio; migrate before deploy`.

---

### Task 10: Docs

**Files:** Modify `README.md`, `docs/architecture.md`, `docs/development.md`, `docs/deploy.md`, `docs/launch-checklist.md`, `docs/superpowers/plans/2026-07-12-recharacter-09-qavren-db-replatform.md` (status addendum), `.github/workflows/dependabot-auto-merge.yml` (no change — leave).

Content requirements:
- README: status table row 02 → "Auth & persistence (Keycloak via qavren-auth + Postgres schema on qavren-db, owner-scoped queries)"; architecture diagram boxes: `qavren-auth (Keycloak realm recharacter)`, `qavren-db (Postgres, schema recharacter)`, `Cloudflare R2 (case-documents)`; quickstart uses `docker compose -f compose.dev.yaml up -d`, `npm run db:migrate`, `npx vitest run`; drop every Supabase mention.
- architecture.md: replace "RLS" paragraphs with the **owner-scoping invariant** (rules 1–2 of Task 6, the ledger guard, the prefix rule for objects) and the fact that the integration suites are the enforcement; env table.
- development.md: local stack (compose.dev.yaml ports 55433/9000), `.env.local` example for local dev against the live Keycloak realm (`QAVREN_AUTH_URL=https://auth.recharacter.us`, `AUTH_SECRET`, `APP_BASE_URL=http://localhost:3000` — `http://localhost:3000/*` is an allowed redirect), MinIO console at :9001, gotchas (`prepare:false`, session URL for migrations, `SET LOCAL` GUC for ledger deletes).
- deploy.md: replace the Supabase section with the **cutover runbook** (below), secrets table (`DEPLOY_*`, `DATABASE_URL_MIGRATE`), box `.env` keys, rollback (`IMAGE_TAG`), post-deploy smoke (register on Keycloak's page → upload → routing → packet → delete account → Keycloak user gone).
- launch-checklist.md: remove the service-role-key item; add R2 bucket, DB secrets, Keycloak admin secret, `verifyEmail` realm follow-up, `@qavren/auth-next` 0.2.0 confidential flip follow-up, delete-old-Supabase-project-after-7-days.
- Plan 09 addendum `## 2026-08-27 — Phases A–D, G shipped`: PR number, what changed, what is Steve's at cutover.

**Cutover runbook (Steve; app secrets never enter git):**
1. R2: create bucket `recharacter-case-documents` (private), an R2 API token scoped to it (Object Read & Write) → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
2. qavren-db: `cd C:\Users\steve\projects\qavren-db; pwsh tools/provision-app.ps1 -App recharacter -Env prod -RotatePassword` → build `DATABASE_URL` (`…pooler.supabase.com:6543`) and `DATABASE_URL_MIGRATE` (`:5432`) → `gh secret set DATABASE_URL_MIGRATE -R stevenfackley/recharacter`; put `DATABASE_URL` in the box `.env`.
3. qavren-auth: confirm the auth box holds `RECHARACTER_ADMIN_CLIENT_SECRET` (compose.prod.yaml refuses to start without it); copy the same value to the box `.env` as `QAVREN_ADMIN_CLIENT_SECRET`.
4. Box `.env`: add `AUTH_SECRET=$(openssl rand -base64 32)`, `AUTH_URL=https://recharacter.us`, `QAVREN_AUTH_URL=https://auth.recharacter.us`, the four `R2_*`, `DATABASE_URL`; remove `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
5. Merge the PR → Deploy runs `migrate` (fails closed if step 2 was skipped) → pulls SHA-tagged images.
6. Smoke as in deploy.md. Old project `ldxgdceplsdycviroisd`: pause now, delete after 7 days (playbook §6).

- [ ] Commit `docs: describe the qavren-auth + qavren-db + R2 platform and the cutover runbook`.

---

### Task 11: Gate and PR

- [ ] `cd web && npm run lint && npx tsc --noEmit && npm run build && npx vitest run` — all green with `compose.dev.yaml` up.
- [ ] `pwsh C:\Users\steve\projects\qavren-db\tools\preflight-app.ps1 -RepoPath C:\Users\steve\projects\recharacter` → `READY`.
- [x] Real-platform rehearsal DONE 2026-08-27: `provision-app.ps1 -App recharacter -Env test -Apply -RotatePassword`, then `npm run db:migrate` over the session pooler (`aws-1-us-east-1.pooler.supabase.com:5432`, `?sslmode=require`) as the app role → `migrations applied` / `already up to date`; `npx vitest run tests` over the transaction pooler (`:6543`) → 8 files, 72 passed, 4 skipped (S3 suite; no MinIO). Credentials discarded; the test role now holds a rotated password nobody stored — rotate again if a test deployment ever needs it.
- [ ] Adversarial review (opus `superpowers:code-reviewer`) of the full diff against the invariants in Task 6; fix; re-run.
- [ ] `gh pr create --base main --title "feat: re-platform onto qavren-auth, qavren-db and R2 (Plan 09 A–D, G)"` — body: what changed, the cutover runbook, the Steve-only steps, follow-ups. Do not merge.
