# Architecture

## The one-sentence version

A **stateless, deterministic .NET routing service** answers the only question where a bug is catastrophic (which board, which form, what deadline); a **Next.js app** owns everything else — auth, state, the wizard, AI, packet assembly, billing — with **Supabase RLS** guaranteeing veterans can only ever see their own records and a **bounded AI gateway** guaranteeing the model can only ever do document-assembly tasks.

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

- **Auth**: Supabase Auth via `@supabase/ssr` — three clients (browser / server / middleware) sharing one cookie `getAll`/`setAll` contract; the root middleware refreshes the session and guards protected routes.
- **State**: every table is owner-scoped (`owner_id = auth.uid()`) under RLS; two-user isolation tests are mandatory for every new table.
- **AI gateway** (Plan 03): a single `POST /api/ai/[task]` route resolving a **task registry** — each task has a fixed system prompt, Zod-validated input, and a JSON-schema-constrained output (`output_config.format`). Key resolution is **BYOK-first**: a user's encrypted key (AES-256-GCM under a server KEK) wins over the managed key, and a corrupted BYOK credential errors rather than silently falling back — the user's privacy/billing expectation beats availability.
- **Packet** (Plan 07): pdf-lib fills the official DD-293/DD-149 and assembles statement + evidence index + cover.

### `supabase/` — migrations

Numbered SQL migrations. RLS is enabled with owner-scoped policies on every table at creation; there are no service-role paths in application code (the service-role key exists only in tests, to provision users).

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
2. **RLS isolation** — two-user + spoof-insert + anonymous tests per table.
3. **BYOK key custody** — AES-256-GCM, tamper tests, no silent managed fallback, no plaintext at rest.
4. **Form fidelity** (Plan 07) — the filled DD form must match the official revision.
