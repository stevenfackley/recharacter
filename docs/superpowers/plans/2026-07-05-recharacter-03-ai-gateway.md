# AI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single, bounded, metered path for every AI call in ReCharacter — supporting both the managed tier (app-held Anthropic key, usage recorded per user) and BYOK (user's own key, stored encrypted, requests billed to their account).

**Architecture:** All AI traffic flows through one Next.js route handler, `POST /api/ai/[task]`. A **task registry** defines every allowed call: its system prompt, prompt builder, and a Zod output schema enforced via the API's structured outputs (`output_config.format`). There are no free-form AI endpoints — this is the anti-UPL boundary in code. A `provider` module picks the key (user's decrypted BYOK key if present, else the app's managed key); a `usage` module records tokens per call. BYOK keys are encrypted at rest with AES-256-GCM under a server-side KEK.

**Tech Stack:** `@anthropic-ai/sdk` (TypeScript), model `claude-opus-4-8` (adaptive thinking; structured outputs), Zod, node:crypto (AES-256-GCM), Supabase (two new RLS tables), Vitest.

**Depends on:** Plan 02 (auth, Supabase clients, `cases` table, middleware). Executes on branch `feat/ai-gateway` after Plan 02 merges.

**Stated assumptions (veto on review):**
- **Model:** `claude-opus-4-8` for every task (drafting quality is the product; do not silently downgrade). Per-task override exists in the registry but defaults to Opus.
- **No streaming in v1** — gateway tasks are bounded extract/draft calls that fit non-streaming at `max_tokens: 16000`. Streaming can be added per-task later.
- Managed-tier metering **records** usage only; Stripe billing/gating is Plan 08.
- KEK is a 32-byte base64 env secret (`AI_KEY_ENCRYPTION_SECRET`); key rotation is out of scope for v1.

---

## File structure

```
supabase/migrations/0003_ai.sql          # ai_credentials + ai_usage, RLS
web/src/lib/ai/
  crypto.ts                              # AES-256-GCM encrypt/decrypt for BYOK keys
  tasks.ts                               # task registry: ping (Plan 04+ add real tasks)
  provider.ts                            # key resolution: BYOK ?? managed; client factory
  usage.ts                               # recordUsage()
web/src/app/api/ai/[task]/route.ts       # the single AI endpoint
web/src/app/settings/ai/page.tsx         # BYOK key management + usage totals
web/src/app/settings/ai/actions.ts       # save/remove key server actions
web/tests/ai-rls.integration.test.ts     # RLS isolation for the two new tables
web/src/lib/ai/crypto.test.ts            # unit
web/src/lib/ai/tasks.test.ts             # unit
web/src/lib/ai/provider.test.ts          # unit (mocked)
web/src/app/api/ai/route.test.ts         # route handler with mocked SDK
```

Env additions (`web/.env.local` + documented in `web/.env.example`):

```
ANTHROPIC_API_KEY=            # managed-tier key (server only)
AI_KEY_ENCRYPTION_SECRET=     # base64, 32 bytes — KEK for BYOK keys (server only)
```

---

## Task 0: Migration — `ai_credentials` and `ai_usage`

**Files:**
- Create: `supabase/migrations/0003_ai.sql`

- [ ] **Step 1: Write the migration**

```sql
-- BYOK: one encrypted provider key per user. The key is AES-256-GCM ciphertext,
-- encrypted server-side before insert; the database never sees plaintext.
create table public.ai_credentials (
    owner_id uuid primary key references auth.users (id) on delete cascade,
    encrypted_key text not null,      -- base64: iv || ciphertext || authTag
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Explicit grants: Postgres checks table privileges BEFORE RLS, and schema default
-- privileges vary by Supabase CLI/image version (CI runs latest). RLS is the only
-- intentional gate.
grant select, insert, update, delete on public.ai_credentials to authenticated;

alter table public.ai_credentials enable row level security;

create policy ai_credentials_select_own on public.ai_credentials
    for select using (auth.uid() = owner_id);
create policy ai_credentials_insert_own on public.ai_credentials
    for insert with check (auth.uid() = owner_id);
create policy ai_credentials_update_own on public.ai_credentials
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy ai_credentials_delete_own on public.ai_credentials
    for delete using (auth.uid() = owner_id);

-- Per-call usage ledger (managed tier bills from this in Plan 08; BYOK rows are
-- informational). Insert-only from the user's own session; no update/delete policies.
create table public.ai_usage (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    task text not null,
    model text not null,
    byok boolean not null default false,
    input_tokens integer not null,
    output_tokens integer not null,
    created_at timestamptz not null default now()
);

create index ai_usage_owner_created_idx on public.ai_usage (owner_id, created_at desc);

-- Insert-only ledger: grant no update/delete at all — the GRANT layer enforces
-- immutability even before RLS gets a say.
grant select, insert on public.ai_usage to authenticated;

alter table public.ai_usage enable row level security;

create policy ai_usage_select_own on public.ai_usage
    for select using (auth.uid() = owner_id);
create policy ai_usage_insert_own on public.ai_usage
    for insert with check (auth.uid() = owner_id);
```

- [ ] **Step 2: Apply and verify**

Run: `supabase db reset`
Expected: applies all migrations (`0001`–`0003`) cleanly. Verify RLS: `supabase db execute "select relname, relrowsecurity from pg_class where relname in ('ai_credentials','ai_usage');"` (adapt the command if this CLI version spells it differently — the check is that both tables report `t`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_ai.sql
git commit -m "feat: add ai_credentials and ai_usage tables with RLS"
```

---

## Task 1: Crypto — AES-256-GCM for BYOK keys

**Files:**
- Create: `web/src/lib/ai/crypto.ts`
- Test: `web/src/lib/ai/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

`web/src/lib/ai/crypto.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/ai/crypto'

// 32 zero bytes, base64 — test KEK only.
const KEK = Buffer.alloc(32).toString('base64')

describe('BYOK crypto', () => {
  test('round-trips a secret', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    expect(decryptSecret(ct, KEK)).toBe('sk-ant-api03-abc123')
  })

  test('ciphertext is not the plaintext and varies per call (random IV)', () => {
    const a = encryptSecret('sk-ant-api03-abc123', KEK)
    const b = encryptSecret('sk-ant-api03-abc123', KEK)
    expect(a).not.toContain('sk-ant')
    expect(a).not.toBe(b)
  })

  test('tampered ciphertext fails authentication', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    const buf = Buffer.from(ct, 'base64')
    buf[buf.length - 1] ^= 0xff // flip a bit in the auth tag
    expect(() => decryptSecret(buf.toString('base64'), KEK)).toThrow()
  })

  test('wrong KEK fails', () => {
    const ct = encryptSecret('sk-ant-api03-abc123', KEK)
    const otherKek = Buffer.alloc(32, 1).toString('base64')
    expect(() => decryptSecret(ct, otherKek)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (from `web/`): `npx vitest run src/lib/ai/crypto.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`web/src/lib/ai/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

/** Encrypts a secret under the base64-encoded 32-byte KEK. Output: base64(iv || ciphertext || tag). */
export function encryptSecret(plaintext: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, kek, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64')
}

export function decryptSecret(payloadBase64: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, 'base64')
  if (kek.length !== 32) throw new Error('KEK must be 32 bytes (base64-encoded)')
  const payload = Buffer.from(payloadBase64, 'base64')
  const iv = payload.subarray(0, IV_LEN)
  const tag = payload.subarray(payload.length - TAG_LEN)
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN)
  const decipher = createDecipheriv(ALG, kek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ai/crypto.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ai/crypto.ts web/src/lib/ai/crypto.test.ts
git commit -m "feat: add AES-256-GCM crypto for BYOK key storage"
```

---

## Task 2: Task registry — bounded AI calls only

**Files:**
- Create: `web/src/lib/ai/tasks.ts`
- Test: `web/src/lib/ai/tasks.test.ts`

Install Zod first (from `web/`): `npm install zod`

- [ ] **Step 1: Write the failing test**

`web/src/lib/ai/tasks.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { getTask, TASKS } from '@/lib/ai/tasks'

describe('task registry', () => {
  test('unknown task returns undefined (route will 404)', () => {
    expect(getTask('draft_anything_you_want')).toBeUndefined()
  })

  test('ping task exists and validates output', () => {
    const ping = getTask('ping')!
    expect(ping.model).toBe('claude-opus-4-8')
    const parsed = ping.outputSchema.safeParse({ ok: true, echo: 'hello' })
    expect(parsed.success).toBe(true)
    expect(ping.outputSchema.safeParse({ nope: 1 }).success).toBe(false)
  })

  test('every task declares the bounded-call contract', () => {
    for (const task of Object.values(TASKS)) {
      expect(task.system.length).toBeGreaterThan(0)
      expect(task.maxTokens).toBeGreaterThan(0)
      expect(task.jsonSchema.additionalProperties).toBe(false)
    }
  })

  test('ping buildPrompt validates its input', () => {
    const ping = getTask('ping')!
    expect(() => ping.buildPrompt({ message: 42 })).toThrow()
    expect(ping.buildPrompt({ message: 'hi' })).toContain('hi')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ai/tasks.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`web/src/lib/ai/tasks.ts`:

```ts
import { z } from 'zod'

/**
 * Every AI call in ReCharacter is a registered, bounded task: fixed system prompt,
 * validated input, JSON-schema-constrained output. There are no free-form endpoints.
 * This is the anti-UPL boundary enforced in code — the model assembles documents and
 * extracts facts; it never gives open-ended advice.
 */
export type AiTask = {
  name: string
  model: 'claude-opus-4-8'
  system: string
  maxTokens: number
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny
  /** JSON Schema mirror of outputSchema, sent as output_config.format (must set additionalProperties: false). */
  jsonSchema: Record<string, unknown> & { additionalProperties: false }
  buildPrompt: (input: unknown) => string
}

const pingInput = z.object({ message: z.string().min(1).max(200) })
const pingOutput = z.object({ ok: z.boolean(), echo: z.string() })

const ping: AiTask = {
  name: 'ping',
  model: 'claude-opus-4-8',
  system:
    'You are the connectivity check for a document-assembly application. ' +
    'Respond only with the JSON the schema requires. Set ok to true and echo the message verbatim.',
  maxTokens: 256,
  inputSchema: pingInput,
  outputSchema: pingOutput,
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, echo: { type: 'string' } },
    required: ['ok', 'echo'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { message } = pingInput.parse(input)
    return `Echo this message back: ${message}`
  },
}

export const TASKS: Record<string, AiTask> = { ping }

export function getTask(name: string): AiTask | undefined {
  return TASKS[name]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ai/tasks.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/ai/tasks.ts web/src/lib/ai/tasks.test.ts
git commit -m "feat: add bounded AI task registry with ping task"
```

---

## Task 3: Provider — BYOK ?? managed key resolution

**Files:**
- Create: `web/src/lib/ai/provider.ts`
- Test: `web/src/lib/ai/provider.test.ts`

Install the SDK (from `web/`): `npm install @anthropic-ai/sdk`

- [ ] **Step 1: Write the failing test**

`web/src/lib/ai/provider.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { resolveApiKey } from '@/lib/ai/provider'
import { encryptSecret } from '@/lib/ai/crypto'

const KEK = Buffer.alloc(32).toString('base64')

describe('provider key resolution', () => {
  test('uses decrypted BYOK key when a credential exists', () => {
    const encrypted = encryptSecret('sk-user-own-key', KEK)
    const r = resolveApiKey({ encryptedByokKey: encrypted, kek: KEK, managedKey: 'sk-managed' })
    expect(r).toEqual({ apiKey: 'sk-user-own-key', byok: true })
  })

  test('falls back to managed key when no credential', () => {
    const r = resolveApiKey({ encryptedByokKey: null, kek: KEK, managedKey: 'sk-managed' })
    expect(r).toEqual({ apiKey: 'sk-managed', byok: false })
  })

  test('throws when neither key is available', () => {
    expect(() => resolveApiKey({ encryptedByokKey: null, kek: KEK, managedKey: undefined })).toThrow(
      /no ai key/i,
    )
  })

  test('a corrupted BYOK credential does NOT silently fall back to the managed key', () => {
    expect(() =>
      resolveApiKey({ encryptedByokKey: 'not-valid-ciphertext', kek: KEK, managedKey: 'sk-managed' }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ai/provider.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`web/src/lib/ai/provider.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { decryptSecret } from '@/lib/ai/crypto'

export type ResolvedKey = { apiKey: string; byok: boolean }

/**
 * BYOK wins when present. A corrupted BYOK credential throws rather than silently
 * falling back to the managed key — otherwise a user who believes their own key is
 * in use (privacy + billing expectation) would silently start billing the app's key.
 */
export function resolveApiKey(opts: {
  encryptedByokKey: string | null
  kek: string
  managedKey: string | undefined
}): ResolvedKey {
  if (opts.encryptedByokKey) {
    return { apiKey: decryptSecret(opts.encryptedByokKey, opts.kek), byok: true }
  }
  if (opts.managedKey) return { apiKey: opts.managedKey, byok: false }
  throw new Error('No AI key available: user has no BYOK credential and no managed key is configured')
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ai/provider.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/ai/provider.ts web/src/lib/ai/provider.test.ts
git commit -m "feat: add BYOK-first provider key resolution"
```

---

## Task 4: Usage recording

**Files:**
- Create: `web/src/lib/ai/usage.ts`

Small enough that its behavior is covered by the route test (Task 5) and the RLS test (Task 6).

- [ ] **Step 1: Implement**

`web/src/lib/ai/usage.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export async function recordUsage(
  supabase: SupabaseClient,
  row: {
    owner_id: string
    task: string
    model: string
    byok: boolean
    input_tokens: number
    output_tokens: number
  },
): Promise<void> {
  const { error } = await supabase.from('ai_usage').insert(row)
  // Metering failures must not eat a successful AI response; log and continue.
  if (error) console.error('ai_usage insert failed', error)
}
```

- [ ] **Step 2: Verify it compiles**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/ai/usage.ts
git commit -m "feat: add ai usage recording"
```

---

## Task 5: The gateway route — `POST /api/ai/[task]`

**Files:**
- Create: `web/src/app/api/ai/[task]/route.ts`
- Test: `web/src/app/api/ai/route.test.ts`

- [ ] **Step 1: Write the failing test**

`web/src/app/api/ai/route.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

function post(task: string, body: unknown) {
  return new NextRequest(`http://localhost/api/ai/${task}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callRoute(task: string, body: unknown) {
  const { POST } = await import('@/app/api/ai/[task]/route')
  return POST(post(task, body), { params: Promise.resolve({ task }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-managed-test'
  process.env.AI_KEY_ENCRYPTION_SECRET = Buffer.alloc(32).toString('base64')
  // default: signed-in user with no BYOK credential and successful usage insert
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'ai_credentials') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
    }
    return { insert: async () => ({ error: null }) }
  })
})

describe('POST /api/ai/[task]', () => {
  test('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(401)
  })

  test('404 for a task not in the registry', async () => {
    const res = await callRoute('freeform_legal_advice', { q: 'help' })
    expect(res.status).toBe(404)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('400 for input that fails the task schema', async () => {
    const res = await callRoute('ping', { message: 42 })
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('happy path: calls Claude, validates output, records usage', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: 'hi' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, echo: 'hi' })

    const call = mockCreate.mock.calls[0][0]
    expect(call.model).toBe('claude-opus-4-8')
    expect(call.output_config.format.type).toBe('json_schema')
  })

  test('502 when the model output fails schema validation', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ wrong: 'shape' }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(502)
  })

  test('422 on refusal stop_reason', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'refusal',
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const res = await callRoute('ping', { message: 'hi' })
    expect(res.status).toBe(422)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/ai/route.test.ts` → FAIL, route module missing.

- [ ] **Step 3: Implement**

`web/src/app/api/ai/[task]/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getTask } from '@/lib/ai/tasks'
import { resolveApiKey, createAnthropicClient } from '@/lib/ai/provider'
import { recordUsage } from '@/lib/ai/usage'

export async function POST(request: NextRequest, ctx: { params: Promise<{ task: string }> }) {
  const { task: taskName } = await ctx.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const task = getTask(taskName)
  if (!task) return NextResponse.json({ error: `Unknown task: ${taskName}` }, { status: 404 })

  let prompt: string
  try {
    prompt = task.buildPrompt(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid input for task' }, { status: 400 })
  }

  const { data: credential } = await supabase
    .from('ai_credentials').select('encrypted_key').eq('owner_id', user.id).maybeSingle()

  let key
  try {
    key = resolveApiKey({
      encryptedByokKey: credential?.encrypted_key ?? null,
      kek: process.env.AI_KEY_ENCRYPTION_SECRET!,
      managedKey: process.env.ANTHROPIC_API_KEY,
    })
  } catch {
    return NextResponse.json({ error: 'AI key unavailable' }, { status: 503 })
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
    return NextResponse.json({ error: 'AI provider error' }, { status: 502 })
  }

  if (response.stop_reason === 'refusal') {
    return NextResponse.json({ error: 'The model declined this request' }, { status: 422 })
  }

  const text = response.content.find((b) => b.type === 'text')
  const parsed = text && 'text' in text ? task.outputSchema.safeParse(JSON.parse(text.text)) : null
  if (!parsed?.success) {
    return NextResponse.json({ error: 'Model output failed validation' }, { status: 502 })
  }

  await recordUsage(supabase, {
    owner_id: user.id,
    task: task.name,
    model: task.model,
    byok: key.byok,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  })

  return NextResponse.json(parsed.data)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/ai/route.test.ts` → PASS (6 tests).
If the SDK's TS types reject `output_config` or `thinking` shapes, check the installed `@anthropic-ai/sdk` version's types and adapt minimally (worst case `// @ts-expect-error` with a comment) — but keep the WIRE shape exactly as above; it is current API.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/ai/[task]/route.ts" web/src/app/api/ai/route.test.ts
git commit -m "feat: add bounded AI gateway route with BYOK and metering"
```

---

## Task 6: RLS isolation for the new tables

**Files:**
- Test: `web/tests/ai-rls.integration.test.ts`

Requires local Supabase running (`supabase start`).

- [ ] **Step 1: Write the test** (validates Task 0's policies; fails loudly if RLS is wrong)

`web/tests/ai-rls.integration.test.ts`:

```ts
import { beforeAll, afterAll, expect, test } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

async function makeUser(email: string): Promise<{ id: string; client: SupabaseClient }> {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: 'Password123!', email_confirm: true,
  })
  if (error) throw error
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  await client.auth.signInWithPassword({ email, password: 'Password123!' })
  return { id: data.user!.id, client }
}

let alice: Awaited<ReturnType<typeof makeUser>>
let bob: Awaited<ReturnType<typeof makeUser>>

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`ai_alice_${suffix}@example.test`)
  bob = await makeUser(`ai_bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user cannot read another user\'s AI credential', async () => {
  await alice.client.from('ai_credentials').insert({ owner_id: alice.id, encrypted_key: 'ciphertext' })
  const { data: bobSees } = await bob.client.from('ai_credentials').select('*')
  expect(bobSees).toEqual([])
})

test('a user cannot spoof-insert a credential for someone else', async () => {
  const { error } = await bob.client
    .from('ai_credentials').insert({ owner_id: alice.id, encrypted_key: 'evil' })
  expect(error).not.toBeNull()
})

test('usage rows are isolated and cannot be updated by their owner (insert-only ledger)', async () => {
  await alice.client.from('ai_usage').insert({
    owner_id: alice.id, task: 'ping', model: 'claude-opus-4-8',
    byok: false, input_tokens: 1, output_tokens: 1,
  })
  const { data: bobSees } = await bob.client.from('ai_usage').select('*')
  expect(bobSees).toEqual([])

  // No update policy exists → an owner update must affect zero rows.
  const { data: updated } = await alice.client
    .from('ai_usage').update({ output_tokens: 999999 }).eq('owner_id', alice.id).select()
  expect(updated).toEqual([])
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run tests/ai-rls.integration.test.ts` → PASS (3 tests). If isolation fails, STOP and fix the Task 0 migration, then `supabase db reset`.

- [ ] **Step 3: Commit**

```bash
git add web/tests/ai-rls.integration.test.ts
git commit -m "test: prove RLS isolation for ai_credentials and ai_usage"
```

---

## Task 7: Settings page — BYOK management + usage totals

**Files:**
- Create: `web/src/app/settings/ai/actions.ts`, `web/src/app/settings/ai/page.tsx`
- Modify: `web/src/proxy.ts` (add `/settings` to `PROTECTED`)

- [ ] **Step 1: Server actions**

`web/src/app/settings/ai/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { encryptSecret } from '@/lib/ai/crypto'

export async function saveByokKey(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const apiKey = String(formData.get('apiKey') ?? '').trim()
  if (!apiKey) throw new Error('API key is required')

  const encrypted = encryptSecret(apiKey, process.env.AI_KEY_ENCRYPTION_SECRET!)
  const { error } = await supabase
    .from('ai_credentials')
    .upsert({ owner_id: user.id, encrypted_key: encrypted, updated_at: new Date().toISOString() })
  if (error) throw error
  revalidatePath('/settings/ai')
}

export async function removeByokKey() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('ai_credentials').delete().eq('owner_id', user.id)
  revalidatePath('/settings/ai')
}
```

- [ ] **Step 2: Page**

`web/src/app/settings/ai/page.tsx`:

```tsx
import { createClient } from '@/lib/supabase/server'
import { saveByokKey, removeByokKey } from './actions'

export default async function AiSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null // middleware redirects; this is belt-and-suspenders

  const { data: credential } = await supabase
    .from('ai_credentials').select('created_at').eq('owner_id', user.id).maybeSingle()

  const { data: usage } = await supabase
    .from('ai_usage').select('input_tokens, output_tokens').eq('owner_id', user.id)
  const totals = (usage ?? []).reduce(
    (acc, r) => ({ input: acc.input + r.input_tokens, output: acc.output + r.output_tokens }),
    { input: 0, output: 0 },
  )

  return (
    <main>
      <h1>AI settings</h1>

      <section>
        <h2>Your own API key (BYOK)</h2>
        {credential ? (
          <>
            <p>A key is saved (encrypted). AI requests bill your own Anthropic account.</p>
            <form action={removeByokKey}>
              <button type="submit">Remove my key</button>
            </form>
          </>
        ) : (
          <>
            <p>No key saved — the managed tier is in use.</p>
            <form action={saveByokKey}>
              <input name="apiKey" type="password" placeholder="sk-ant-..." required />
              <button type="submit">Save key</button>
            </form>
          </>
        )}
      </section>

      <section>
        <h2>Usage</h2>
        <p>{totals.input.toLocaleString()} input / {totals.output.toLocaleString()} output tokens</p>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Protect `/settings` in middleware**

In `web/src/proxy.ts`, change:

```ts
const PROTECTED = ['/case']
```
to:
```ts
const PROTECTED = ['/case', '/settings']
```

- [ ] **Step 4: Full verification**

From `web/` (local Supabase running):

```bash
npm run build
npx vitest run
```
Expected: build green; all unit + integration tests green (Plan 02's suites + crypto 4 + tasks 4 + provider 4 + route 6 + ai-rls 3).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/settings web/src/proxy.ts
git commit -m "feat: add BYOK settings page and protect /settings"
```

---

## Definition of done (Plan 03)

- `supabase db reset` applies `0003_ai.sql`; both tables report RLS enabled.
- The two-user isolation test proves credentials and usage rows are invisible cross-user, spoof-inserts fail, and `ai_usage` is effectively insert-only.
- `POST /api/ai/ping` (signed in, with a real `ANTHROPIC_API_KEY` in `.env.local`) returns `{ ok: true, echo: ... }` — one manual smoke test.
- Route rejects: unauthenticated (401), unknown task (404), invalid input (400), refusal (422), invalid model output (502).
- A user can save an encrypted BYOK key, see the managed/BYOK state, and remove it; `byok: true` is recorded on usage rows when their key served the call.
- No plaintext API key ever appears in the database, logs, or client-visible payloads.

## Notes for later plans

- Plan 04 adds the first real task (`extract_service_facts`) to `tasks.ts` — vision/PDF input will extend `buildPrompt` to content blocks; the registry contract stays the same.
- Plan 06 adds `kurta_slot` + `draft_statement` tasks (drafting may switch to streaming; revisit the no-streaming assumption there).
- Plan 08 reads `ai_usage` for Stripe metering and adds the free-tier gate in this route.
