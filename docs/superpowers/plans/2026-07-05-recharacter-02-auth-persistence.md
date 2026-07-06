# Auth & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in veteran reaches a protected wizard shell and owns exactly one `cases` row that Postgres RLS makes invisible to every other user — proven by a two-user isolation test.

**Architecture:** A Next.js 15 App Router (TypeScript) app in `web/`, authenticating against **local Supabase** (Postgres + Auth via the Supabase CLI + Docker) using `@supabase/ssr`. A `cases` table keyed by `owner_id = auth.uid()` with RLS policies confining every operation to the owner. Root middleware refreshes the session and guards protected routes. Migrations live in `supabase/migrations`. Vitest drives the tests, centered on an RLS integration test that authenticates as two users and asserts isolation.

**Tech Stack:** Next.js 15, TypeScript, `@supabase/ssr`, `@supabase/supabase-js`, Supabase CLI (local stack), Vitest, `@testing-library/react`.

**Stated assumptions (implementation defaults — veto any on review):**
- **Local-first Supabase** (CLI + Docker Desktop). No cloud project until a dedicated deploy plan.
- **Auth = email + password** (Supabase Auth). Magic link is deferred — better UX, but harder to e2e-test; revisit before launch.
- **One active Case per user** for MVP. The schema allows many rows; the app uses the most recent.
- **`web/` holds the Next.js app**; the .NET routing service (Plan 01) stays in `src/` at the repo root. They share the repo, deploy independently, and do not reference each other until Plan 04 (over HTTP).

**Prerequisites (verify before Task 0):**
- `node --version` ≥ 22, `supabase --version` present, Docker Desktop running (`docker info` succeeds).

---

## File structure

```
supabase/
  config.toml                         # from `supabase init`
  migrations/
    0001_cases.sql                    # cases table + RLS policies
web/
  package.json  tsconfig.json  next.config.ts  vitest.config.ts
  .env.local    .env.example
  src/
    middleware.ts                     # session refresh + route guard
    lib/supabase/
      server.ts                       # RSC / route-handler client
      client.ts                       # browser client
      middleware.ts                   # middleware client + refresh helper
    lib/cases.ts                      # getOrCreateCase()
    app/
      (auth)/login/page.tsx  (auth)/login/actions.ts
      (auth)/signup/page.tsx (auth)/signup/actions.ts
      auth/signout/route.ts
      case/page.tsx                   # protected wizard shell
  tests/
    rls.integration.test.ts           # the centerpiece: two-user isolation
```

---

## Task 0: Scaffold the Next.js app and Vitest

**Files:** Create `web/` via the Next.js scaffolder, then add test deps.

- [ ] **Step 1: Scaffold**

Run from repo root (`C:\Users\steve\projects\recharacter`):

```bash
npx create-next-app@latest web --ts --app --eslint --src-dir --use-npm --no-tailwind --import-alias "@/*"
```

Accept defaults for any remaining prompts (no Turbopack requirement either way).

- [ ] **Step 2: Add runtime + test dependencies**

```bash
cd web
npm install @supabase/ssr @supabase/supabase-js
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom dotenv
cd ..
```

- [ ] **Step 3: Vitest config**

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
```

Add to `web/package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 4: Verify it builds and the (empty) test runner works**

```bash
cd web && npm run build && npx vitest run --passWithNoTests && cd ..
```
Expected: build succeeds; Vitest reports "no test files found" and exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/ .gitignore
git commit -m "chore: scaffold Next.js web app with Vitest"
```

---

## Task 1: Initialize local Supabase and wire env

**Files:** Create `supabase/config.toml` (generated), `web/.env.local`, `web/.env.example`.

- [ ] **Step 1: Init and start the local stack**

Run from repo root:

```bash
supabase init
supabase start
```

`supabase start` prints an `API URL` (typically `http://127.0.0.1:54321`), an `anon key`, and a `service_role key`. Capture these for the next step (also re-printable via `supabase status`).

- [ ] **Step 2: Write env files**

Create `web/.env.local` (fill the two values from `supabase status`; the service-role key is used ONLY by tests, never shipped to the browser):

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
```

Create `web/.env.example` (committed; no secrets):

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 3: Confirm `.env.local` is gitignored**

`create-next-app` already ignores `.env*`. Verify `web/.gitignore` contains `.env*` and that `git status` does NOT list `web/.env.local`.

- [ ] **Step 4: Commit**

```bash
git add supabase/config.toml web/.env.example
git commit -m "chore: init local Supabase and add env template"
```

---

## Task 2: `cases` table and RLS policies

**Files:** Create `supabase/migrations/0001_cases.sql`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_cases.sql`:

```sql
-- A veteran's discharge-upgrade effort. Owned by exactly one auth user.
create table public.cases (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index cases_owner_id_idx on public.cases (owner_id);

-- Row-level security: a user may touch ONLY their own cases. Default-deny once enabled.
alter table public.cases enable row level security;

create policy cases_select_own on public.cases
    for select using (auth.uid() = owner_id);

create policy cases_insert_own on public.cases
    for insert with check (auth.uid() = owner_id);

create policy cases_update_own on public.cases
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy cases_delete_own on public.cases
    for delete using (auth.uid() = owner_id);
```

- [ ] **Step 2: Apply and verify**

```bash
supabase db reset
```
Expected: reset re-applies all migrations including `0001_cases.sql` without error. Then confirm RLS is on:

```bash
supabase db execute "select relrowsecurity from pg_class where relname = 'cases';"
```
Expected: `relrowsecurity = t`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0001_cases.sql
git commit -m "feat: add cases table with owner-scoped RLS"
```

---

## Task 3: RLS isolation integration test (the crux)

This is the most important test in the plan: it proves veteran A's data is invisible to veteran B. It runs against the live local Supabase stack, so it is an integration test, not a unit test.

**Files:** Create `web/tests/rls.integration.test.ts`.

- [ ] **Step 1: Write the RLS isolation test** (validates Task 2's policies; passes when they're correct, fails loudly if RLS is misconfigured)

`web/tests/rls.integration.test.ts`:

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
    email,
    password: 'Password123!',
    email_confirm: true,
  })
  if (error) throw error
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: 'Password123!' })
  if (signInErr) throw signInErr
  return { id: data.user!.id, client }
}

let alice: { id: string; client: SupabaseClient }
let bob: { id: string; client: SupabaseClient }

beforeAll(async () => {
  // Unique emails per run so repeated runs don't collide (no Date.now available in engine,
  // but this is a Node test process — a random suffix is fine here).
  const suffix = Math.random().toString(36).slice(2, 8)
  alice = await makeUser(`alice_${suffix}@example.test`)
  bob = await makeUser(`bob_${suffix}@example.test`)
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(alice.id)
  await admin.auth.admin.deleteUser(bob.id)
})

test('a user can insert and read their own case', async () => {
  const { data, error } = await alice.client.from('cases').insert({ owner_id: alice.id }).select().single()
  expect(error).toBeNull()
  expect(data!.owner_id).toBe(alice.id)

  const { data: rows } = await alice.client.from('cases').select('*')
  expect(rows).toHaveLength(1)
})

test('a user CANNOT read another user\'s case (RLS isolation)', async () => {
  await alice.client.from('cases').insert({ owner_id: alice.id })

  const { data: bobSees } = await bob.client.from('cases').select('*')
  expect(bobSees).toEqual([]) // RLS filters Alice's rows out entirely for Bob
})

test('a user CANNOT insert a case owned by someone else', async () => {
  const { error } = await bob.client.from('cases').insert({ owner_id: alice.id })
  expect(error).not.toBeNull() // insert WITH CHECK (auth.uid() = owner_id) rejects the spoof
})

test('an anonymous client sees no cases', async () => {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data } = await anon.from('cases').select('*')
  expect(data).toEqual([])
})
```

- [ ] **Step 2: Run to verify it passes against local Supabase**

Ensure `supabase start` is running, then:

```bash
cd web && npx vitest run tests/rls.integration.test.ts && cd ..
```
Expected: all 4 tests PASS. If the isolation test fails (Bob sees Alice's row), STOP — the RLS policy in Task 2 is wrong; fix the migration and `supabase db reset` before continuing. This failure is the whole reason the test exists.

- [ ] **Step 3: Commit**

```bash
git add web/tests/rls.integration.test.ts
git commit -m "test: prove RLS isolates cases between users"
```

---

## Task 4: `@supabase/ssr` clients

**Files:** Create `web/src/lib/supabase/server.ts`, `client.ts`, `middleware.ts`.

- [ ] **Step 1: Browser client**

`web/src/lib/supabase/client.ts`:

```ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
```

- [ ] **Step 2: Server client (RSC / route handlers / server actions)**

`web/src/lib/supabase/server.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Called from a Server Component where setting cookies throws; middleware refreshes instead.
          }
        },
      },
    },
  )
}
```

- [ ] **Step 3: Middleware client + session refresh helper**

`web/src/lib/supabase/middleware.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  // Refresh the auth token. Do not run logic between createServerClient and getUser().
  const { data: { user } } = await supabase.auth.getUser()

  return { response, user }
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/supabase/
git commit -m "feat: add supabase ssr clients (browser, server, middleware)"
```

---

## Task 5: Root middleware — refresh session and guard `/case`

**Files:** Create `web/src/middleware.ts`. Test: `web/src/middleware.test.ts`.

- [ ] **Step 1: Write the failing test**

`web/src/middleware.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Force "no user" from the refresh helper so we exercise the guard branch.
vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: async (request: NextRequest) => ({
    response: (await import('next/server')).NextResponse.next({ request }),
    user: null,
  }),
}))

test('unauthenticated request to /case is redirected to /login', async () => {
  const { middleware } = await import('@/middleware')
  const res = await middleware(new NextRequest('http://localhost/case'))

  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toContain('/login')
})

test('unauthenticated request to a public route is not redirected', async () => {
  const { middleware } = await import('@/middleware')
  const res = await middleware(new NextRequest('http://localhost/login'))

  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/middleware.test.ts && cd ..`
Expected: FAIL — `@/middleware` does not exist.

- [ ] **Step 3: Implement**

`web/src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const PROTECTED = ['/case']

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request)

  const needsAuth = PROTECTED.some((p) => request.nextUrl.pathname.startsWith(p))
  if (needsAuth && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/middleware.test.ts && cd ..`
Expected: PASS — both cases green.

- [ ] **Step 5: Commit**

```bash
git add web/src/middleware.ts web/src/middleware.test.ts
git commit -m "feat: refresh session and guard protected routes in middleware"
```

---

## Task 6: Auth — signup, login, signout

**Files:** Create `web/src/app/(auth)/login/{page.tsx,actions.ts}`, `web/src/app/(auth)/signup/{page.tsx,actions.ts}`, `web/src/app/auth/signout/route.ts`.

- [ ] **Step 1: Login server action + page**

`web/src/app/(auth)/login/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function login(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  })
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`)
  redirect('/case')
}
```

`web/src/app/(auth)/login/page.tsx`:

```tsx
import { login } from './actions'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Sign in</h1>
      {error && <p role="alert">{error}</p>}
      <form action={login}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
      <a href="/signup">Create an account</a>
    </main>
  )
}
```

- [ ] **Step 2: Signup server action + page**

`web/src/app/(auth)/signup/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function signup(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  })
  if (error) redirect(`/signup?error=${encodeURIComponent(error.message)}`)
  redirect('/case')
}
```

`web/src/app/(auth)/signup/page.tsx`:

```tsx
import { signup } from './actions'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Create your account</h1>
      {error && <p role="alert">{error}</p>}
      <form action={signup}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Create account</button>
      </form>
      <a href="/login">I already have an account</a>
    </main>
  )
}
```

- [ ] **Step 3: Signout route**

`web/src/app/auth/signout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
```

- [ ] **Step 4: Verify build**

Run: `cd web && npm run build && cd ..`
Expected: build succeeds; `/login`, `/signup`, and the signout route compile.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/(auth)" web/src/app/auth
git commit -m "feat: add email/password signup, login, and signout"
```

---

## Task 7: `getOrCreateCase()` and the protected wizard shell

**Files:** Create `web/src/lib/cases.ts`, `web/src/app/case/page.tsx`. Test: `web/tests/cases.integration.test.ts`.

- [ ] **Step 1: Write the failing integration test**

`web/tests/cases.integration.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

// Mirror of getOrCreateCase's data logic, exercised directly against a signed-in client.
// (The Next server helper wraps this same query set; here we verify the idempotency contract.)
async function getOrCreate(client: SupabaseClient, userId: string) {
  const existing = await client
    .from('cases').select('*').eq('owner_id', userId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing.data) return existing.data
  const created = await client.from('cases').insert({ owner_id: userId }).select().single()
  if (created.error) throw created.error
  return created.data
}

let user: { id: string; client: SupabaseClient }

beforeAll(async () => {
  const email = `caseuser_${Math.random().toString(36).slice(2, 8)}@example.test`
  const { data } = await admin.auth.admin.createUser({ email, password: 'Password123!', email_confirm: true })
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  await client.auth.signInWithPassword({ email, password: 'Password123!' })
  user = { id: data.user!.id, client }
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(user.id)
})

test('getOrCreate is idempotent: two calls yield the same case', async () => {
  const first = await getOrCreate(user.client, user.id)
  const second = await getOrCreate(user.client, user.id)
  expect(second.id).toBe(first.id)

  const { data: all } = await user.client.from('cases').select('*')
  expect(all).toHaveLength(1) // exactly one case, not two
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd web && npx vitest run tests/cases.integration.test.ts && cd ..`
Expected: PASS (the query logic works against the Task 2 schema). This test locks the idempotency contract that `getOrCreateCase` must honor. If it inserts two rows, the `maybeSingle`/ordering logic is wrong — fix before Step 3.

- [ ] **Step 3: Implement the server helper**

`web/src/lib/cases.ts`:

```ts
import { createClient } from '@/lib/supabase/server'

export type Case = { id: string; owner_id: string; created_at: string; updated_at: string }

/** Returns the signed-in user's most recent case, creating one if none exists. */
export async function getOrCreateCase(): Promise<Case> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: existing } = await supabase
    .from('cases').select('*').eq('owner_id', user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existing) return existing as Case

  const { data: created, error } = await supabase
    .from('cases').insert({ owner_id: user.id }).select().single()
  if (error) throw error
  return created as Case
}
```

- [ ] **Step 4: Wizard shell page**

`web/src/app/case/page.tsx`:

```tsx
import { getOrCreateCase } from '@/lib/cases'

const STEPS = ['Intake', 'Routing', 'Evidence', 'Nexus', 'Draft', 'Coaching', 'Packet'] as const

export default async function CasePage() {
  const c = await getOrCreateCase()
  return (
    <main>
      <h1>Your discharge-upgrade case</h1>
      <p>Case ID: {c.id}</p>
      <ol>
        {STEPS.map((step) => (
          <li key={step}>{step} — not started</li>
        ))}
      </ol>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 5: Verify build and full test run**

```bash
cd web && npm run build && npx vitest run && cd ..
```
Expected: build succeeds; all Vitest tests green (RLS isolation + cases idempotency + middleware guard). Local Supabase must be running for the integration tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/cases.ts web/src/app/case/page.tsx web/tests/cases.integration.test.ts
git commit -m "feat: add getOrCreateCase and protected wizard shell"
```

---

## Definition of done (Plan 02)

- `supabase start` running; `supabase db reset` applies `0001_cases.sql` cleanly with RLS enabled.
- A user can sign up, sign in, land on `/case`, and see a wizard shell listing their (empty) steps and one Case ID.
- An unauthenticated request to `/case` redirects to `/login`.
- **The RLS isolation test proves user B cannot read, and cannot spoof-insert, user A's case; an anonymous client sees nothing.**
- `getOrCreateCase` is idempotent (one case per user).
- `npm run build` succeeds and `npx vitest run` is fully green with local Supabase running.

## Notes for later plans

- The `cases` table is intentionally minimal. Plans 04–07 add child tables (`service_facts`, `evidence_items`, `nexus_answers`, `drafts`, …), each with the same `owner_id`/RLS pattern and each covered by an isolation assertion.
- The wizard `STEPS` array is a placeholder shell; each feature plan replaces its step with a real view.
- Cloud Supabase provisioning + deploy is a separate later plan; nothing here assumes a hosted project.
