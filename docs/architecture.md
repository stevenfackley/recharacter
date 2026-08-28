# Architecture

## The one-sentence version

A **stateless, deterministic .NET routing service** answers the only question where a bug is catastrophic (which board, which form, what deadline); a **Next.js app** owns everything else — auth, state, the wizard, AI, packet assembly, billing — with an **owner-scoping invariant enforced in code** guaranteeing veterans can only ever see their own records and a **bounded AI gateway** guaranteeing the model can only ever do document-assembly tasks.

## Components

### `src/` — ReCharacter.RulesEngine + RoutingApi (.NET 10)

| Unit | Responsibility |
|------|----------------|
| `BoardDirectory` | branch → board names (ADRB/ABCMR, NDRB/BCNR, AFDRB/AFBCMR, CGDRB/BCMR-DHS) |
| `DrbWindow` | the 15-year DRB filing window (inclusive deadline day; leap-day clamping pinned by test) |
| `DischargeRouter` | orchestration: facts → `RoutingResult` (board, form, deadline, availability, advisory flags) |
| `IClock` / `SystemClock` | the only place wall-clock time enters. `SystemClock` resolves "today" at **UTC-11** (westernmost inhabited U.S. zone) so the engine can never falsely tell a veteran their window closed — a false "you're too late" is the worst error this product can make |
| `RoutingApi` | thin minimal API: `POST /route`, RFC 7807 problem+json errors, enum-as-string JSON |

Design rules: pure functions, injected clock (no `DateTime.Now` outside `SystemClock`), no I/O, no persistence. The service holds no data and knows nothing about users — the web app calls it over HTTP with extracted facts and stores the result.

### `web/` — Next.js (App Router, TypeScript)

- **Auth**: every request authenticates through Auth.js v5, composed by `@qavren/auth-next` (Keycloak OIDC code flow + PKCE, encrypted JWT cookie) against the qavren-auth realm `recharacter`. `getSessionUser()` (`web/src/lib/session.ts`) is the *only* place identity is read; `session.user.id` is the Keycloak `sub`, and that value is `owner_id` everywhere in the app. `web/src/proxy.ts` is the Next 16 middleware that gates protected routes and appends `?next=` for post-login redirect.
- **State**: Drizzle over Postgres (`web/src/db/`), schema `recharacter` on qavren-db. There is no RLS — see "Owner-scoping invariant" below.
- **Storage**: Cloudflare R2 (S3 API) behind an `ObjectStore` interface (`web/src/lib/storage/`) — see "Storage model" below.
- **AI gateway** (Plan 03): a single `POST /api/ai/[task]` route resolving a **task registry** — each task has a fixed system prompt, Zod-validated input, and a JSON-schema-constrained output (`output_config.format`). Key resolution is **BYOK-first**: a user's encrypted key (AES-256-GCM under a server KEK, AAD-bound to `owner_id`) wins over the managed key, and a corrupted BYOK credential errors rather than silently falling back — the user's privacy/billing expectation beats availability.
- **Packet** (Plan 07): pdf-lib fills the official DD-293/DD-149 and assembles statement + evidence index + cover.

## Owner-scoping invariant (replaces RLS)

qavren-db gives ReCharacter one Postgres schema (`recharacter`) and one role that owns it and nothing else — that's the isolation wall *between apps*. Isolation *between veterans within this app* has no database mechanism (no RLS on a shared-role schema) and is instead a set of rules enforced in the `lib/*.ts` data modules, proven by integration tests rather than assumed:

1. **Every statement carries `owner_id = session user`.** Every `select`/`update`/`delete` in every data module has `eq(table.ownerId, ownerId)` in its `where` clause — even when a `caseId` is already present.
2. **Every case-scoped write first proves ownership.** Before touching `service_facts`, `case_context`, `evidence_items`, `nexus_answers`, or `drafts`, the write calls `assertCaseOwned(ownerId, caseId)`, which throws `CaseNotFoundError` if the case doesn't belong to that owner.
3. **The append-only ledgers are guarded by a trigger, not application discipline.** `ai_usage` and `entitlements` reject `UPDATE`/`DELETE` with Postgres error `42501` unless the transaction first runs `SET LOCAL recharacter.allow_ledger_delete = 'on'` — only account deletion does that.
4. **Object keys carry the same prefix rule.** Every R2/S3 key is `{ownerId}/{caseId}/{uuid}-{name}`; every read, list, and delete asserts the caller's prefix before touching the key (`assertOwnedKey` in `web/src/lib/case-documents.ts`).

**The `web/tests/*-scoping.integration.test.ts` suites (two synthetic owners, Alice/Bob) are the enforcement of this invariant, not a nice-to-have** — they run in CI against real Postgres 17 + MinIO on every PR, and every new owner-scoped table or object type must add a case to them before it ships.

## Identity flow

```
veteran ──▶ /login ──▶ signIn('keycloak') ──▶ Keycloak hosted page (login / register / reset)
        ◀── Auth.js JWT cookie ◀── OIDC code flow (PKCE) ◀──┘
```

- Registration and password reset happen entirely on Keycloak's hosted, branded pages — the app has no email/password form of its own. `signIn('keycloak', …, { prompt: 'create' })` deep-links straight to the registration form.
- Sign-out is RP-initiated: `web/src/app/auth/signout/route.ts` calls Auth.js `signOut()` (drops the app's cookie) and then redirects to Keycloak's `/protocol/openid-connect/logout` with `id_token_hint`, so the Keycloak SSO session dies too — required because this is a shared-computer PII app.
- Account deletion calls the Keycloak Admin API as the service account `recharacter-admin-svc` (`realm-management: manage-users` only — no data-plane access), via `web/src/lib/keycloak-admin.ts`. It fails closed: if `QAVREN_ADMIN_CLIENT_SECRET` is unset or the token request fails, nothing is deleted.
- The client is currently `recharacter-web` (public, PKCE). Once `@qavren/auth-next` ≥ 0.2.0 publishes, flip to `confidential: true` + `QAVREN_CLIENT_SECRET` against `recharacter-web-confidential`.

## Storage model

Case documents go through an `ObjectStore` interface (`web/src/lib/storage/object-store.ts`) with two implementations: `S3ObjectStore` (R2 in prod, MinIO in dev/CI, both speak the S3 API) and `MemoryObjectStore` (unit tests). Every upload is size-capped (15 MiB) and its content type is determined server-side by magic-byte sniffing (`sniffContentType` in `web/src/lib/case-documents.ts`) — the client-declared MIME type is never trusted. Deletion sweeps list-then-remove against the owner's prefix and re-verifies the prefix is empty before returning.

## Env contract

| Var | Purpose |
|---|---|
| `DATABASE_URL` | postgres-js runtime URL — qavren-db transaction pooler, `:6543` |
| `DATABASE_URL_MIGRATE` | session-mode URL, `:5432` — used only by `npm run db:migrate` |
| `AUTH_SECRET` | Auth.js cookie encryption; read by Auth.js directly |
| `AUTH_URL` | canonical origin behind the tunnel (`https://recharacter.us`) |
| `QAVREN_AUTH_URL` | Keycloak base, default `https://auth.recharacter.us` |
| `QAVREN_REALM` | realm / client-id prefix, default `recharacter` |
| `QAVREN_ADMIN_CLIENT_ID` | deletion service account, default `recharacter-admin-svc` |
| `QAVREN_ADMIN_CLIENT_SECRET` | its secret — account deletion fails closed without it |
| `KEYCLOAK_ADMIN_BASE_URL` | optional override for the admin API host |
| `APP_BASE_URL` | `https://recharacter.us` — Stripe redirects + post-logout redirect |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | object store credentials |
| `S3_ENDPOINT` | MinIO endpoint override for dev/CI |
| `ANTHROPIC_API_KEY`, `AI_KEY_ENCRYPTION_SECRET`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_MANAGED_DAILY_TOKEN_CAP`, `AI_GLOBAL_DAILY_TOKEN_CAP` | AI gateway |
| `ROUTING_API_URL` | .NET routing service URL |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` | billing |
| `TUNNEL_TOKEN` | Cloudflare Tunnel |

## Data flow (happy path)

```
veteran story + records ──▶ AI extract (bounded task) ──▶ ServiceFacts
ServiceFacts ──▶ POST /route (.NET) ──▶ board + form + deadline + flags
facts + Kurta interview ──▶ AI draft (bounded task) ──▶ statement
statement + evidence + filled DD form ──▶ packet PDF ──▶ veteran files it
```

## Decisions and why

| Decision | Why |
|----------|-----|
| Two languages (.NET + TS) instead of one | The routing/deadline logic ports Reclaim's proven engine discipline (pure + injected clock + heavy xUnit). Everything else is one TypeScript codebase. |
| No Python sidecar (unlike sibling product Reclaim) | The cloud model (Claude) reads PDFs/photos natively — OCR/embedding infrastructure would be dead weight. Reclaim needed it only because its PHI constraint forced local inference. |
| Frontier cloud model, not local | The single highest-value output is a persuasive nexus statement; drafting quality decides cases. Hybrid delivery (managed proxy + BYOK) covers both convenience and privacy/cost preferences. |
| No shared code with Reclaim | Rule of three — copy the proven decisions, not the code. Revisit at product #3. |
| Packet-only (veteran files) | Filing on a veteran's behalf edges into representation, which can require VSO/attorney accreditation. |
| Bounded AI tasks only | The anti-UPL boundary is structural, not a policy document: there is no endpoint through which the model can be asked an open-ended legal question. |

## Correctness surfaces (ranked)

1. **Deadline math** — day-before/day-of/day-after + leap-day tests; generous UTC-11 clock.
2. **Owner-scoping isolation** — two-user integration suites per table/object type, run against real Postgres + MinIO in CI (see "Owner-scoping invariant" above).
3. **BYOK key custody** — AES-256-GCM, tamper tests, no silent managed fallback, no plaintext at rest.
4. **Form fidelity** (Plan 07) — the filled DD form must match the official revision.
