# Billing & Freemium Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The freemium boundary from the design spec, enforced in code: everything through the evidence checklist is free; AI drafting and the packet unlock with EITHER a one-time paid case unlock (Stripe Checkout) OR a BYOK key (the veteran already bears the AI cost).

**Architecture:** An `entitlements` table (owner-RLS). Entitlement = `paid unlock exists OR ai_credentials row exists` — resolved by one helper (`isEntitled`) used in two chokepoints: the AI gateway (tasks marked `premium: true` return **402** when unentitled) and the packet route. Payments: **hosted Stripe Checkout, one-time price, redirect-verification, NO webhook** — a `pending_checkouts` row is written (as the user, under RLS) before redirecting to Stripe; the success page (and a "restore purchase" action) retrieves the session server-side from Stripe's API and, iff `payment_status === 'paid'` and the session's `client_reference_id` matches the signed-in user, inserts the entitlement as that user. No service-role key enters app code.

**Tech Stack:** existing stack + `stripe` (server SDK). New env: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `APP_BASE_URL`.

**Depends on:** Plan 07 merged.

**Stated assumptions (veto on review):**
- **Flat one-time unlock per account** (not per case — one active case per user at MVP anyway; spec's "metered vs flat" open question resolved to flat for simplicity). Price lives in the Stripe Price object, not code.
- Premium surfaces: `shape_nexus_answer`, `draft_statement`, `draft_cover_letter`, packet download. Free (deliberately): intake extraction (acquisition cost), `coaching_note` (tiny engagement cost), `ping`, everything deterministic.
- No refund/subscription lifecycle in MVP; the entitlement row is permanent once written.
- Without `STRIPE_SECRET_KEY` configured, the upgrade page renders a "payments not yet configured" notice and BYOK remains the working path — all tests mock Stripe; no live key needed anywhere.

---

## File structure

```
supabase/migrations/0007_entitlements.sql
web/src/lib/billing.ts                    # isEntitled, entitlement/pending persistence
web/src/lib/billing.test.ts
web/src/lib/ai/tasks.ts                   # + premium: true flags (3 tasks)
web/src/lib/ai/gateway.ts                 # + 402 gate for premium tasks
web/src/app/api/ai/route.test.ts          # + 402 cases (additive)
web/src/app/api/packet/route.ts           # + entitlement gate (402)
web/src/app/case/upgrade/page.tsx         # freemium explainer + checkout + restore + BYOK pointer
web/src/app/case/upgrade/actions.ts       # startCheckout, restorePurchase
web/tests/entitlements-rls.integration.test.ts
```

---

## Task 0: Migration — `entitlements` + `pending_checkouts`

```sql
-- One row = the account's paid unlock. Insert happens as the signed-in user after
-- server-side verification of the Stripe session (redirect-verification model).
create table public.entitlements (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null unique references auth.users (id) on delete cascade,
    kind text not null default 'case_unlock' check (kind in ('case_unlock')),
    stripe_session_id text not null unique,
    created_at timestamptz not null default now()
);

create index entitlements_owner_idx on public.entitlements (owner_id);

grant select, insert on public.entitlements to authenticated;
revoke update, delete, truncate on public.entitlements from authenticated, anon;

alter table public.entitlements enable row level security;
create policy entitlements_select_own on public.entitlements
    for select using (auth.uid() = owner_id);
create policy entitlements_insert_own on public.entitlements
    for insert with check (auth.uid() = owner_id);

-- Checkout sessions we've started and not yet verified; lets "restore purchase"
-- recover a paid session even if the success redirect never happened.
create table public.pending_checkouts (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    stripe_session_id text not null unique,
    created_at timestamptz not null default now()
);

create index pending_checkouts_owner_idx on public.pending_checkouts (owner_id);

grant select, insert, delete on public.pending_checkouts to authenticated;
revoke update, truncate on public.pending_checkouts from authenticated, anon;

alter table public.pending_checkouts enable row level security;
create policy pending_checkouts_select_own on public.pending_checkouts
    for select using (auth.uid() = owner_id);
create policy pending_checkouts_insert_own on public.pending_checkouts
    for insert with check (auth.uid() = owner_id);
create policy pending_checkouts_delete_own on public.pending_checkouts
    for delete using (auth.uid() = owner_id);
```

Apply (`supabase db reset`, Kong-flake fix if needed), verify RLS on both, commit:
`feat: add entitlements and pending_checkouts tables with RLS`

---

## Task 1: `isEntitled` + persistence helpers

`web/src/lib/billing.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * The freemium gate. Entitled = paid unlock OR a BYOK key on file — a veteran
 * who brings their own Anthropic key already bears the AI cost, so charging
 * them again would be double-dipping (design spec §10).
 */
export async function isEntitled(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const [{ data: paid }, { data: byok }] = await Promise.all([
    supabase.from('entitlements').select('id').eq('owner_id', userId).maybeSingle(),
    supabase.from('ai_credentials').select('owner_id').eq('owner_id', userId).maybeSingle(),
  ])
  return Boolean(paid) || Boolean(byok)
}

export async function recordPendingCheckout(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('pending_checkouts').insert({ owner_id: user.id, stripe_session_id: sessionId })
  if (error) throw error
}

/** Idempotent: 23505 on the unique session id means it's already recorded. */
export async function grantEntitlement(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('entitlements')
    .insert({ owner_id: user.id, kind: 'case_unlock', stripe_session_id: sessionId })
  if (error && error.code !== '23505') throw error
  await supabase.from('pending_checkouts').delete().eq('stripe_session_id', sessionId)
}
```

Unit test (`billing.test.ts`, mocked supabase clients like `coaching-transport.test.ts`): entitled via paid only, via BYOK only, via neither → false; `grantEntitlement` swallows 23505 but rethrows other errors. Commit: `feat: add entitlement resolution and checkout persistence`

---

## Task 2: Gateway 402 gate + premium flags

1. `tasks.ts`: add optional `premium?: true` to `AiTask`; set it on `shape_nexus_answer`, `draft_statement`, `draft_cover_letter` ONLY.
2. `gateway.ts` `executeAiTask`: after the task lookup and input validation, before key resolution:

```ts
  if (task.premium) {
    const entitled = await isEntitled(supabase, userId)
    if (!entitled) {
      return { ok: false, status: 402, error: 'This feature needs the case unlock or your own API key' }
    }
  }
```

Add `402` to the `AiTaskResult` status union. NOTE the ordering subtlety: BYOK users pass via `isEntitled`'s credential check; the later BYOK-vs-managed key resolution is unchanged.
3. Tests (additive to `route.test.ts` + a small `tasks.test.ts` assertion): a premium task without entitlement → 402 and `mockCreate` NOT called; with a mocked entitlement row → proceeds; `ping` (non-premium) unaffected; assert exactly the three intended tasks carry `premium` (registry contract test: `Object.values(TASKS).filter(t => t.premium).map(t => t.name).sort()` equals the expected trio — pins against accidental gating/ungating).
4. Drafting/nexus server actions: surface 402 as a redirect to `/case/upgrade` (friendly, not an error string).
Commit: `feat: gate premium AI tasks on entitlement with 402`

---

## Task 3: Packet route gate

In `web/src/app/api/packet/route.ts`, after auth: `if (!(await isEntitled(supabase, user.id))) return NextResponse.json({ error: '…' , upgrade: '/case/upgrade' }, { status: 402 })`. Additive route tests: 402 unentitled; happy path with entitlement mocked. The packet page mirrors the gate (renders the upgrade link instead of the download button). Commit: `feat: gate packet download on entitlement`

---

## Task 4: Checkout + restore actions and the upgrade page

`web/src/app/case/upgrade/actions.ts`:
- `startCheckout()`: auth → `new Stripe(process.env.STRIPE_SECRET_KEY)` (503-style friendly redirect if unset) → `stripe.checkout.sessions.create({ mode: 'payment', line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }], client_reference_id: user.id, success_url: `${APP_BASE_URL}/case/upgrade?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP_BASE_URL}/case/upgrade?canceled=1` })` → `recordPendingCheckout(session.id)` → `redirect(session.url)`.
- `verifySession(sessionId)`: retrieve from Stripe; require `payment_status === 'paid'` AND `client_reference_id === user.id`; then `grantEntitlement(sessionId)`. Called by the page when `?session_id=` present, and by `restorePurchase()` which iterates the user's `pending_checkouts` rows verifying each.
`page.tsx`: entitlement status (paid / BYOK / none); what's free vs unlocked (copy from spec §10); checkout button; restore button; BYOK pointer to `/settings/ai`; `?canceled=1` notice. Tests: mocked `stripe` module — startCheckout records pending + redirects to session.url; verifySession refuses unpaid sessions and mismatched `client_reference_id` (the security-critical assertions), grants on valid.
Commit: `feat: add stripe checkout, restore purchase, and the upgrade page`

---

## Task 5: RLS integration tests + env docs + full verify

- `entitlements-rls.integration.test.ts` (two-user harness, `en_` emails): cross-user read `[]`; spoof-insert rejected; **owner UPDATE/DELETE on entitlements refused (42501)** — the no-revocation-by-client property; pending_checkouts isolation.
- `web/.env.example`: `STRIPE_SECRET_KEY=`, `STRIPE_PRICE_ID=`, `APP_BASE_URL=http://localhost:3000` with comments. `.env.local` gets `APP_BASE_URL` only (no live Stripe key needed).
- Full `npx vitest run` + `npm run build` green.
Commit: `test: prove RLS isolation for entitlements and pending checkouts`

---

## Definition of done (Plan 08)

- Unentitled: drafting tasks and packet return 402 with a friendly upgrade path; everything through the evidence checklist (and intake extraction + coaching) still works.
- Entitled via BYOK key alone: full access, no payment.
- Entitled via paid unlock: full access on the managed key.
- `verifySession` cannot be satisfied by an unpaid session or another user's session; entitlements are client-immutable (42501-pinned).
- The premium-task trio is pinned by a registry test; no Stripe key is required for any test or for BYOK users in production.
- Full suite + build green.

## Notes / deferred

- Stripe webhook (for bulletproof fulfillment) + subscription/refund lifecycle: post-MVP; `pending_checkouts` + restore covers the redirect-loss case.
- Live Stripe products/prices, real pricing, and the managed-tier per-token economics review (ai_usage is already metering): launch checklist items with the attorney/pricing pass.
