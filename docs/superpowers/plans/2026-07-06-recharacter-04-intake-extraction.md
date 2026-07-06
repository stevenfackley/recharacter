# Intake & Document Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A veteran uploads their DD-214 (photo or PDF) or types their facts manually, reviews/confirms the extracted facts, and sees their computed routing: board, form, filing deadline, and advisory flags.

**Architecture:** A `service_facts` table (one row per case, owner-RLS) holds the four facts routing needs. Uploads land in a private Supabase Storage bucket (`case-documents`, owner-scoped paths). The AI gateway's core is refactored out of the route handler into a callable library (`executeAiTask`) so server actions can run tasks directly; a new bounded task `extract_service_facts` reads the document via Claude's native vision/PDF input and returns nullable structured fields (never guesses). Extraction only *prefills* a review form — **the veteran confirms every fact before routing runs**. Routing calls the .NET service over HTTP via a thin typed client.

**Tech Stack:** existing stack + Supabase Storage; no new packages.

**Depends on:** Plans 01–03 (all merged to main).

**Stated assumptions (veto on review):**
- **Human-confirmation gate:** extracted facts are `confirmed=false` until the veteran reviews and submits them; routing renders only for confirmed facts. This is the extraction-accuracy mitigation — AI never silently feeds the router.
- **Document bytes go to the model from the upload request** (already in memory); Storage is the durable record. No separate OCR path.
- **Routing is recomputed on render**, never persisted — the .NET service is stateless and cheap; no staleness class of bugs. If it's unreachable, the page says so.
- Upload limits: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, ≤ 15 MB.
- Document deletion/retention UI is deferred (tracked for a later plan; the storage delete policy ships now).

**Prerequisites:** local Supabase running; for the live routing display, the .NET API must run locally (`dotnet run --project src/ReCharacter.RoutingApi`) — read its port from `src/ReCharacter.RoutingApi/Properties/launchSettings.json` and set `ROUTING_API_URL` accordingly in `web/.env.local` (documented in Task 2). All automated tests mock fetch/SDK and need neither the .NET service nor an Anthropic key.

---

## File structure

```
supabase/migrations/0004_service_facts.sql   # facts table + storage bucket/policies
web/src/lib/facts.ts                         # zod schema + get/save helpers
web/src/lib/routing.ts                       # typed client for POST /route
web/src/lib/ai/gateway.ts                    # executeAiTask (extracted route core)
web/src/lib/ai/tasks.ts                      # + content-block support + extract_service_facts
web/src/app/api/ai/[task]/route.ts           # thin wrapper over executeAiTask
web/src/app/case/intake/page.tsx             # upload + review/confirm forms
web/src/app/case/intake/actions.ts           # uploadAndExtract, confirmFacts
web/src/app/case/page.tsx                    # + facts status + routing display
web/src/lib/facts.test.ts
web/src/lib/routing.test.ts
web/tests/service-facts-rls.integration.test.ts
web/tests/storage-rls.integration.test.ts
```

Env additions: `ROUTING_API_URL` in `web/.env.local` (real port) and `web/.env.example` (empty + comment).

---

## Task 0: Migration — `service_facts` + `case-documents` bucket

**Files:** Create `supabase/migrations/0004_service_facts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- The four facts discharge routing needs, exactly one row per case.
-- Values mirror the .NET RulesEngine enums verbatim (PascalCase) so the routing
-- client can pass them through without mapping.
create table public.service_facts (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    branch text not null check (branch in
        ('Army','Navy','MarineCorps','AirForce','SpaceForce','CoastGuard')),
    discharge_date date not null,
    characterization text not null check (characterization in
        ('Honorable','GeneralUnderHonorable','OtherThanHonorable',
         'BadConductDischarge','DishonorableDischarge','Uncharacterized')),
    was_general_court_martial boolean not null default false,
    source text not null default 'manual' check (source in ('manual','extracted')),
    confirmed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index service_facts_owner_idx on public.service_facts (owner_id);

-- Declare the full privilege state (grant AND revoke — defaults may have granted more).
grant select, insert, update, delete on public.service_facts to authenticated;
revoke truncate on public.service_facts from authenticated, anon;

alter table public.service_facts enable row level security;

create policy service_facts_select_own on public.service_facts
    for select using (auth.uid() = owner_id);
create policy service_facts_insert_own on public.service_facts
    for insert with check (auth.uid() = owner_id);
create policy service_facts_update_own on public.service_facts
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy service_facts_delete_own on public.service_facts
    for delete using (auth.uid() = owner_id);

-- Private bucket for uploaded records. Path convention: {user_id}/{case_id}/{file}.
-- Owner-scoping is enforced by matching the first path segment to auth.uid().
insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

create policy case_docs_select_own on storage.objects
    for select to authenticated
    using (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy case_docs_insert_own on storage.objects
    for insert to authenticated
    with check (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy case_docs_delete_own on storage.objects
    for delete to authenticated
    using (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
```

- [ ] **Step 2: Apply and verify**

`supabase db reset` (Kong-flake fix if needed: `docker restart supabase_kong_recharacter`). Verify with `supabase db query "select relname, relrowsecurity from pg_class where relname = 'service_facts';"` → `t`, and `supabase db query "select id from storage.buckets;"` includes `case-documents`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_service_facts.sql
git commit -m "feat: add service_facts table and case-documents bucket with RLS"
```

---

## Task 1: Facts schema + persistence helpers

**Files:** Create `web/src/lib/facts.ts`. Test: `web/src/lib/facts.test.ts`

- [ ] **Step 1: Write the failing test**

`web/src/lib/facts.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { serviceFactsSchema } from '@/lib/facts'

const valid = {
  branch: 'MarineCorps',
  dischargeDate: '2024-06-01',
  characterization: 'OtherThanHonorable',
  wasGeneralCourtMartial: false,
}

describe('serviceFactsSchema', () => {
  test('accepts a valid fact set', () => {
    expect(serviceFactsSchema.safeParse(valid).success).toBe(true)
  })

  test('rejects an unknown branch', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, branch: 'Starfleet' }).success).toBe(false)
  })

  test('rejects a malformed date', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, dischargeDate: '06/01/2024' }).success).toBe(false)
  })

  test('rejects an unknown characterization', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, characterization: 'Medium' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/facts.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

`web/src/lib/facts.ts`:

```ts
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
  dischargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date (YYYY-MM-DD)'),
  characterization: z.enum(CHARACTERIZATIONS),
  wasGeneralCourtMartial: z.boolean(),
})

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
      confirmed: opts.confirmed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/facts.test.ts` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/facts.ts web/src/lib/facts.test.ts
git commit -m "feat: add service facts schema and persistence helpers"
```

---

## Task 2: Routing client (typed, mocked-fetch tests)

**Files:** Create `web/src/lib/routing.ts`. Test: `web/src/lib/routing.test.ts`. Env vars.

- [ ] **Step 1: Write the failing test**

`web/src/lib/routing.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { routeDischarge } from '@/lib/routing'

const RESULT = {
  recommendedBoard: 'Drb',
  recommendedForm: 'DD293',
  boardName: 'NDRB',
  availableBoards: ['Drb', 'Bcmr'],
  drbDeadline: '2039-06-01',
  drbWindowOpen: true,
  flags: [],
}

beforeEach(() => {
  process.env.ROUTING_API_URL = 'http://routing.test'
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('routeDischarge', () => {
  test('POSTs facts and returns the parsed RoutingResult', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(RESULT), { status: 200 }),
    )
    const result = await routeDischarge({
      branch: 'MarineCorps',
      dischargeDate: '2024-06-01',
      characterization: 'OtherThanHonorable',
      wasGeneralCourtMartial: false,
    })
    expect(result.recommendedBoard).toBe('Drb')
    expect(result.boardName).toBe('NDRB')

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('http://routing.test/route')
    expect(JSON.parse(String(init!.body)).branch).toBe('MarineCorps')
  })

  test('throws on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 500 }))
    await expect(routeDischarge({
      branch: 'Army', dischargeDate: '2020-01-01',
      characterization: 'Honorable', wasGeneralCourtMartial: false,
    })).rejects.toThrow(/routing service/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement**

`web/src/lib/routing.ts`:

```ts
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
```

- [ ] **Step 4: Env wiring**

Read the .NET port from `src/ReCharacter.RoutingApi/Properties/launchSettings.json` (the `http` profile's `applicationUrl`). Append to `web/.env.local` (NOT committed): `ROUTING_API_URL=http://localhost:<that port>`. Append to `web/.env.example` (committed):

```
# .NET routing service (dotnet run --project src/ReCharacter.RoutingApi)
ROUTING_API_URL=
```

- [ ] **Step 5: Run to verify it passes** — `npx vitest run src/lib/routing.test.ts` → PASS (2).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/routing.ts web/src/lib/routing.test.ts web/.env.example
git commit -m "feat: add typed routing client for the .NET service"
```

---

## Task 3: Extract the gateway core into a callable library

Server actions must run AI tasks directly (no cookie-forwarding HTTP hop to our own route). Move the route's core into `executeAiTask`; the route becomes a thin adapter. **Behavior is identical — the existing 6 route tests must pass unchanged.**

**Files:** Create `web/src/lib/ai/gateway.ts`. Modify `web/src/app/api/ai/[task]/route.ts`.

- [ ] **Step 1: Implement the library**

`web/src/lib/ai/gateway.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { getTask } from '@/lib/ai/tasks'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'

export type AiTaskResult =
  | { ok: true; data: unknown }
  | { ok: false; status: 400 | 404 | 422 | 502 | 503; error: string }

/**
 * The single execution path for every AI call (used by the API route AND by
 * server actions). Caller must have already authenticated the user.
 */
export async function executeAiTask(
  supabase: SupabaseClient,
  userId: string,
  taskName: string,
  input: unknown,
): Promise<AiTaskResult> {
  const task = getTask(taskName)
  if (!task) return { ok: false, status: 404, error: `Unknown task: ${taskName}` }

  let prompt
  try {
    prompt = task.buildPrompt(input)
  } catch {
    return { ok: false, status: 400, error: 'Invalid input for task' }
  }

  const { data: credential } = await supabase
    .from('ai_credentials').select('encrypted_key').eq('owner_id', userId).maybeSingle()

  let key
  try {
    key = resolveApiKey({
      encryptedByokKey: credential?.encrypted_key ?? null,
      kek: process.env.AI_KEY_ENCRYPTION_SECRET!,
      managedKey: process.env.ANTHROPIC_API_KEY,
    })
  } catch {
    return { ok: false, status: 503, error: 'AI key unavailable' }
  }

  const client = createAnthropicClient(key.apiKey)

  let response
  try {
    response = await client.messages.create({
      model: task.model,
      max_tokens: task.maxTokens,
      thinking: { type: 'adaptive' },
      system: task.system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: task.jsonSchema } },
    })
  } catch (err) {
    console.error(`ai task ${task.name} provider error`, err)
    return { ok: false, status: 502, error: 'AI provider error' }
  }

  // Tokens are spent the moment the provider returns — meter BEFORE validation.
  await recordUsage(supabase, {
    owner_id: userId,
    task: task.name,
    model: task.model,
    byok: key.byok,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  })

  if (response.stop_reason === 'refusal') {
    return { ok: false, status: 422, error: 'The model declined this request' }
  }

  const text = response.content.find((b) => b.type === 'text')
  let parsed: ReturnType<typeof task.outputSchema.safeParse> | null = null
  if (text && 'text' in text) {
    try {
      parsed = task.outputSchema.safeParse(JSON.parse(text.text))
    } catch {
      // Non-JSON / truncated output — same failure class as a shape mismatch.
    }
  }
  if (!parsed?.success) {
    return { ok: false, status: 502, error: 'Model output failed validation' }
  }

  return { ok: true, data: parsed.data }
}
```

Move the request-shape code out of the route so both callers share it verbatim (this is a move, not a rewrite — keep the exact provider/metering/validation logic currently in the route, including comments).

- [ ] **Step 2: Thin the route**

`web/src/app/api/ai/[task]/route.ts` (replace entire file):

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'

export async function POST(request: NextRequest, ctx: { params: Promise<{ task: string }> }) {
  const { task: taskName } = await ctx.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid input for task' }, { status: 400 })
  }

  const result = await executeAiTask(supabase, user.id, taskName, input)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data)
}
```

- [ ] **Step 3: Verify the existing route tests pass UNCHANGED**

`npx vitest run src/app/api/ai/route.test.ts` → PASS (6/6). If any fail, the refactor changed behavior — fix the library, not the tests.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/ai/gateway.ts "web/src/app/api/ai/[task]/route.ts"
git commit -m "refactor: extract AI gateway core into callable library"
```

---

## Task 4: Content-block input + the `extract_service_facts` task

**Files:** Modify `web/src/lib/ai/tasks.ts`. Modify test `web/src/lib/ai/tasks.test.ts`.

- [ ] **Step 1: Write the failing tests** (append to the `describe` block in `tasks.test.ts`)

```ts
  test('extract_service_facts builds document content blocks', () => {
    const extract = getTask('extract_service_facts')!
    const content = extract.buildPrompt({
      documentBase64: 'aGVsbG8=',
      mediaType: 'application/pdf',
    }) as Array<Record<string, unknown>>

    expect(Array.isArray(content)).toBe(true)
    const doc = content.find((b) => b.type === 'document') as Record<string, unknown>
    expect((doc.source as Record<string, unknown>).data).toBe('aGVsbG8=')
    expect(content.some((b) => b.type === 'text')).toBe(true)
  })

  test('extract_service_facts uses an image block for images', () => {
    const extract = getTask('extract_service_facts')!
    const content = extract.buildPrompt({
      documentBase64: 'aGVsbG8=',
      mediaType: 'image/jpeg',
    }) as Array<Record<string, unknown>>
    expect(content.some((b) => b.type === 'image')).toBe(true)
    expect(content.some((b) => b.type === 'document')).toBe(false)
  })

  test('extract_service_facts output allows nulls for unreadable fields', () => {
    const extract = getTask('extract_service_facts')!
    const parsed = extract.outputSchema.safeParse({
      branch: null, dischargeDate: null, characterization: null,
      wasGeneralCourtMartial: null, notes: 'document illegible',
    })
    expect(parsed.success).toBe(true)
  })
```

- [ ] **Step 2: Run to verify they fail** — task doesn't exist.

- [ ] **Step 3: Implement**

In `web/src/lib/ai/tasks.ts`:

1. Widen the contract — change the `buildPrompt` signature on `AiTask` to:

```ts
  /** Returns a plain string OR an array of Anthropic content blocks (vision/PDF tasks). */
  buildPrompt: (input: unknown) => string | Array<Record<string, unknown>>
```

(The gateway already passes the value straight through as `content`, which the SDK accepts for both shapes — no gateway change needed. The loose block type avoids coupling to SDK internal type paths; the wire shape is what matters.)

2. Add the task:

```ts
const extractInput = z.object({
  documentBase64: z.string().min(1),
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  notes: z.string().max(2000).optional(),
})

const extractOutput = z.object({
  branch: z.enum(BRANCH_VALUES).nullable(),
  dischargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  characterization: z.enum(CHARACTERIZATION_VALUES).nullable(),
  wasGeneralCourtMartial: z.boolean().nullable(),
  notes: z.string(),
})

const extract_service_facts: AiTask = {
  name: 'extract_service_facts',
  model: 'claude-opus-4-8',
  system:
    'You extract structured facts from a US military separation document (typically a DD-214) ' +
    'for a document-assembly application. Read the document and report ONLY what it states. ' +
    'If a field is not clearly present, return null for it — never guess or infer. ' +
    'branch: the service branch. dischargeDate: the separation date (ISO YYYY-MM-DD). ' +
    'characterization: the character of service exactly as one of the allowed values. ' +
    'wasGeneralCourtMartial: true only if the document shows the discharge resulted from a ' +
    'general court-martial. notes: one or two sentences on anything ambiguous or unreadable. ' +
    'You provide no advice or opinions of any kind.',
  maxTokens: 2048,
  inputSchema: extractInput,
  outputSchema: extractOutput,
  jsonSchema: {
    type: 'object',
    properties: {
      branch: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...BRANCH_VALUES] }] },
      dischargeDate: { anyOf: [{ type: 'null' }, { type: 'string' }] },
      characterization: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...CHARACTERIZATION_VALUES] }] },
      wasGeneralCourtMartial: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
      notes: { type: 'string' },
    },
    required: ['branch', 'dischargeDate', 'characterization', 'wasGeneralCourtMartial', 'notes'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { documentBase64, mediaType, notes } = extractInput.parse(input)
    const source = { type: 'base64', media_type: mediaType, data: documentBase64 }
    const docBlock =
      mediaType === 'application/pdf'
        ? { type: 'document', source }
        : { type: 'image', source }
    return [
      docBlock,
      {
        type: 'text',
        text:
          'Extract the service facts from this document.' +
          (notes ? ` Context from the veteran (facts in the document still win): ${notes}` : ''),
      },
    ]
  },
}
```

Define `BRANCH_VALUES` / `CHARACTERIZATION_VALUES` as const tuples at the top of `tasks.ts` (same literals as `web/src/lib/facts.ts`) and register the task in `TASKS`.

3. The existing **drift test** compares top-level keys — it covers the new task automatically. The existing "bounded-call contract" test also picks it up.

- [ ] **Step 4: Run all task tests** — `npx vitest run src/lib/ai/tasks.test.ts` → PASS (8: original 4 + drift + 3 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ai/tasks.ts web/src/lib/ai/tasks.test.ts
git commit -m "feat: add extract_service_facts task with document content blocks"
```

---

## Task 5: RLS integration tests — `service_facts` + storage

**Files:** Create `web/tests/service-facts-rls.integration.test.ts`, `web/tests/storage-rls.integration.test.ts`

- [ ] **Step 1: Write the service_facts test** (same two-user harness pattern as `rls.integration.test.ts` — copy the `makeUser`/`beforeAll`/`afterAll` scaffolding verbatim, with fresh random emails prefixed `sf_`):

Tests (each following the established assertion style):
1. Owner can insert and read their own facts row (insert a valid row with a fresh `case_id` created via the owner's `cases` insert; select returns 1).
2. Bob cannot read Alice's facts (`bobSees` → `[]`).
3. Bob cannot spoof-insert facts with `owner_id: alice.id` (error non-null).
4. Bob cannot update Alice's facts (update…select → `[]`).
5. One-facts-per-case: Alice inserting a second row for the same `case_id` errors with code `23505`.

Note: `service_facts.case_id` references `cases`, and Alice already has a case from `cases_one_per_owner` — create the case row first inside the test via `alice.client.from('cases').insert(...).select().single()` (or reuse if 23505, re-select).

- [ ] **Step 2: Write the storage test**

`web/tests/storage-rls.integration.test.ts` (same harness; emails prefixed `st_`):

```ts
test('a user can upload to and read from their own folder', async () => {
  const path = `${alice.id}/case-x/dd214.txt`
  const { error: upErr } = await alice.client.storage
    .from('case-documents').upload(path, new Blob(['hello']), { upsert: true })
  expect(upErr).toBeNull()

  const { data, error: downErr } = await alice.client.storage
    .from('case-documents').download(path)
  expect(downErr).toBeNull()
  expect(await data!.text()).toBe('hello')
})

test('a user CANNOT upload into another user\'s folder', async () => {
  const { error } = await bob.client.storage
    .from('case-documents').upload(`${alice.id}/case-x/evil.txt`, new Blob(['evil']))
  expect(error).not.toBeNull()
})

test('a user CANNOT download another user\'s document', async () => {
  const { data, error } = await bob.client.storage
    .from('case-documents').download(`${alice.id}/case-x/dd214.txt`)
  expect(data).toBeNull()
  expect(error).not.toBeNull()
})
```

- [ ] **Step 3: Run both** (stack up) — `npx vitest run tests/service-facts-rls.integration.test.ts tests/storage-rls.integration.test.ts` → all PASS. If isolation fails, STOP and fix the migration.

- [ ] **Step 4: Commit**

```bash
git add web/tests/service-facts-rls.integration.test.ts web/tests/storage-rls.integration.test.ts
git commit -m "test: prove RLS isolation for service_facts and case documents"
```

---

## Task 6: Intake server actions + pages

**Files:** Create `web/src/app/case/intake/actions.ts`, `web/src/app/case/intake/page.tsx`

- [ ] **Step 1: Server actions**

`web/src/app/case/intake/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { serviceFactsSchema, saveServiceFacts } from '@/lib/facts'

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 15 * 1024 * 1024

/** Upload a separation document, extract facts with AI, save them UNCONFIRMED. */
export async function uploadAndExtract(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const file = formData.get('document')
  if (!(file instanceof File) || file.size === 0) {
    redirect('/case/intake?error=' + encodeURIComponent('Choose a file to upload'))
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    redirect('/case/intake?error=' + encodeURIComponent('PDF, JPEG, PNG, or WebP only'))
  }
  if (file.size > MAX_BYTES) {
    redirect('/case/intake?error=' + encodeURIComponent('File too large (15 MB max)'))
  }

  const c = await getOrCreateCase()
  const bytes = Buffer.from(await file.arrayBuffer())

  // Durable record first (path convention {user}/{case}/{file} — enforced by storage RLS).
  const path = `${user!.id}/${c.id}/${crypto.randomUUID()}-${file.name}`
  const { error: upErr } = await supabase.storage
    .from('case-documents')
    .upload(path, bytes, { contentType: file.type })
  if (upErr) {
    redirect('/case/intake?error=' + encodeURIComponent('Upload failed; try again'))
  }

  // Extraction is a bounded task; the result only PREFILLS the review form.
  const result = await executeAiTask(supabase, user!.id, 'extract_service_facts', {
    documentBase64: bytes.toString('base64'),
    mediaType: file.type,
  })
  if (!result.ok) {
    redirect('/case/intake?error=' + encodeURIComponent(
      'Could not read the document automatically — enter your facts below',
    ))
  }

  const d = result.data as {
    branch: string | null; dischargeDate: string | null
    characterization: string | null; wasGeneralCourtMartial: boolean | null
  }

  // Save only if extraction produced a COMPLETE, valid fact set; partial results
  // still prefill the form via query params. Either way the veteran must confirm.
  const candidate = {
    branch: d.branch, dischargeDate: d.dischargeDate,
    characterization: d.characterization,
    wasGeneralCourtMartial: d.wasGeneralCourtMartial ?? false,
  }
  const parsed = serviceFactsSchema.safeParse(candidate)
  if (parsed.success) {
    await saveServiceFacts(c.id, parsed.data, { source: 'extracted', confirmed: false })
    redirect('/case/intake?extracted=1')
  }
  const qs = new URLSearchParams()
  if (d.branch) qs.set('branch', d.branch)
  if (d.dischargeDate) qs.set('dischargeDate', d.dischargeDate)
  if (d.characterization) qs.set('characterization', d.characterization)
  qs.set('partial', '1')
  redirect(`/case/intake?${qs.toString()}`)
}

/** The human-confirmation gate: the veteran reviews and submits the final facts. */
export async function confirmFacts(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const parsed = serviceFactsSchema.safeParse({
    branch: String(formData.get('branch') ?? ''),
    dischargeDate: String(formData.get('dischargeDate') ?? ''),
    characterization: String(formData.get('characterization') ?? ''),
    wasGeneralCourtMartial: formData.get('wasGeneralCourtMartial') === 'on',
  })
  if (!parsed.success) {
    redirect('/case/intake?error=' + encodeURIComponent('Check the highlighted fields'))
  }

  await saveServiceFacts(c.id, parsed.data, { source: 'manual', confirmed: true })
  redirect('/case')
}
```

- [ ] **Step 2: Intake page**

`web/src/app/case/intake/page.tsx`:

```tsx
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts, BRANCHES, CHARACTERIZATIONS } from '@/lib/facts'
import { uploadAndExtract, confirmFacts } from './actions'

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)

  const prefill = {
    branch: params.branch ?? facts?.branch ?? '',
    dischargeDate: params.dischargeDate ?? facts?.dischargeDate ?? '',
    characterization: params.characterization ?? facts?.characterization ?? '',
    wasGeneralCourtMartial: facts?.wasGeneralCourtMartial ?? false,
  }

  return (
    <main>
      <h1>Your service facts</h1>
      {params.error && <p role="alert">{params.error}</p>}
      {params.extracted && (
        <p role="status">
          We read your document. Review every field below — you confirm what is correct.
        </p>
      )}
      {params.partial && (
        <p role="status">
          We could read some of your document. Fill in the rest below.
        </p>
      )}

      <section>
        <h2>Upload your DD-214 (or similar separation document)</h2>
        <form action={uploadAndExtract}>
          <input name="document" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required />
          <button type="submit">Upload and read</button>
        </form>
        <p>PDF or photo, 15 MB max. Stored privately; only you can access it.</p>
      </section>

      <section>
        <h2>Or enter the facts yourself</h2>
        <form action={confirmFacts}>
          <label>
            Branch
            <select name="branch" defaultValue={prefill.branch} required>
              <option value="" disabled>Select…</option>
              {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label>
            Discharge date
            <input name="dischargeDate" type="date" defaultValue={prefill.dischargeDate} required />
          </label>
          <label>
            Characterization of service
            <select name="characterization" defaultValue={prefill.characterization} required>
              <option value="" disabled>Select…</option>
              {CHARACTERIZATIONS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
            </select>
          </label>
          <label>
            <input
              name="wasGeneralCourtMartial" type="checkbox"
              defaultChecked={prefill.wasGeneralCourtMartial}
            />
            My discharge resulted from a general court-martial
          </label>
          <button type="submit">Confirm these facts</button>
        </form>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Verify build** — `npm run build` → green.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/case/intake
git commit -m "feat: add intake page with upload-extract and confirm-facts flows"
```

---

## Task 7: Routing display on `/case` + full verification

**Files:** Modify `web/src/app/case/page.tsx`

- [ ] **Step 1: Replace the wizard shell page**

`web/src/app/case/page.tsx` (replace entire file):

```tsx
import Link from 'next/link'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { routeDischarge, type RoutingResult } from '@/lib/routing'

const LATER_STEPS = ['Evidence', 'Nexus', 'Draft', 'Coaching', 'Packet'] as const

const FLAG_TEXT: Record<string, string> = {
  PastDrbWindow: 'The 15-year Discharge Review Board window has closed for this discharge.',
  GeneralCourtMartialRequiresBcmr:
    'Discharges from a general court-martial can only be reviewed by the correction board.',
  CoastGuardDhsPolicyDiffers:
    'Coast Guard boards operate under DHS; policies are similar to DoD but not identical.',
  BcmrThreeYearStatuteWaiverLikely:
    'The correction board has a 3-year filing rule, but it is routinely waived in the interest of justice.',
  EntryLevelSeparationUncharacterized:
    'An uncharacterized (entry-level) separation is not a derogatory characterization; boards can still change it.',
  AlreadyHonorableNothingToUpgrade:
    'This service is already characterized as Honorable — there is no characterization to upgrade.',
}

export default async function CasePage() {
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)

  let routing: RoutingResult | null = null
  let routingError = false
  if (facts?.confirmed) {
    try {
      routing = await routeDischarge({
        branch: facts.branch,
        dischargeDate: facts.dischargeDate,
        characterization: facts.characterization,
        wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
      })
    } catch {
      routingError = true
    }
  }

  return (
    <main>
      <h1>Your discharge-upgrade case</h1>

      <section>
        <h2>1. Service facts</h2>
        {facts?.confirmed ? (
          <p>
            {facts.branch}, discharged {facts.dischargeDate} ({facts.characterization}).{' '}
            <Link href="/case/intake">Edit</Link>
          </p>
        ) : (
          <p>
            <Link href="/case/intake">
              {facts ? 'Review and confirm your facts' : 'Start here: add your service facts'}
            </Link>
          </p>
        )}
      </section>

      <section>
        <h2>2. Where your case goes</h2>
        {!facts?.confirmed && <p>Confirm your service facts first.</p>}
        {routingError && <p role="alert">The routing service is unavailable right now — try again shortly.</p>}
        {routing && (
          <>
            <p>
              <strong>{routing.boardName}</strong> — file{' '}
              <strong>{routing.recommendedForm === 'DD293' ? 'DD Form 293' : 'DD Form 149'}</strong>
            </p>
            <p>
              {routing.drbWindowOpen
                ? `The Discharge Review Board window is open until ${routing.drbDeadline}.`
                : 'The 15-year Discharge Review Board window has closed; the correction board is the path.'}
            </p>
            {routing.flags.length > 0 && (
              <ul>
                {routing.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}
              </ul>
            )}
            <p>
              This is the computed filing route for the facts you confirmed — it is process
              information, not legal advice.
            </p>
          </>
        )}
      </section>

      <ol start={3}>
        {LATER_STEPS.map((step) => <li key={step}>{step} — not started</li>)}
      </ol>

      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Full verification**

From `web/` (stack up): `npx vitest run` → ALL green (32 existing + facts 4 + routing 2 + tasks +3 + service-facts RLS 5 + storage RLS 3 ≈ 49). `npm run build` → green.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/case/page.tsx
git commit -m "feat: show computed routing on the case page after facts confirmation"
```

---

## Definition of done (Plan 04)

- Migrations apply cleanly; `service_facts` + storage policies RLS-proven by two-user tests (including cross-user upload/download denial).
- The full Vitest suite (~49) and `npm run build` are green; the 6 pre-existing route tests pass **unchanged** after the gateway refactor.
- Manual flow (needs `ANTHROPIC_API_KEY` + the .NET service running — DEFERRED if no key is configured): upload a DD-214 photo → review prefilled facts → confirm → `/case` shows board, form, deadline, and plain-English flags.
- Extraction can never set `confirmed=true` — only `confirmFacts` (the human gate) can.
- No document bytes or extracted PII appear in logs.

## Notes for later plans

- Plan 05 (evidence/coaching) reads `service_facts` + routing flags to personalize the checklist.
- Document listing/deletion UI + retention policy: deferred, tracked for Plan 05 or a dedicated privacy plan.
- The routing display's `FLAG_TEXT` copy is part of the attorney-review surface before launch.
