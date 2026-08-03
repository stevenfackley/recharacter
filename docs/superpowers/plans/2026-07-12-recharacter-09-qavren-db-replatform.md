# Plan 09 — Re-platform onto qavren-db + qavren-auth

**Date:** 2026-07-12
**Directive:** Steve — "use the new qavren database schema for this shit and then you don't have to worry about it."
**Fleet context:** qavren-db `docs/migration-playbook.md` inventory #13: *recharacter — Refactor: RLS+Storage+GoTrue admin → backend-mediated + R2.* The playbook's pre-flight gate fails on all four conditions today, so this refactor precedes any migration step.
**Playbook correction:** the inventory says "local CLI stack only / no prod data to move" — stale. Cloud project `ldxgdceplsdycviroisd` is live behind recharacter.us since 2026-07-07. Data volume is founder-testing only; §F decides fresh-provision vs copy.

## What this buys

- No per-app Supabase project, no service-role key on the box (the key was found missing in prod on 2026-07-11 — deletion failing closed; this plan deletes the entire key-custody problem instead of managing it).
- One bill, platform-owned backups (nightly per-schema dump → R2), hard Postgres-grant isolation.
- Identity on the fleet convention (Keycloak realm-per-app via qavren-auth).

## Current coupling (pre-flight sweep, 2026-07-12)

- 74 supabase-js import/creation sites across 35 files — **all server-side** (SSR helpers in `web/src/lib/supabase/`, server actions, route handlers). Nothing client-side imports Supabase (verified at deploy PR #13 and re-verified today).
- 37 auth/storage call sites across 24 files: `auth.getUser()` everywhere, signup/login/signout actions, middleware session refresh, `auth.admin.deleteUser` (settings/data), `storage.from('case-documents')` (intake upload, export, deletion sweep).
- Migrations 0001–0008: RLS + explicit grants; `auth.users` FKs on every owner_id.
- CI: "Web (RLS integration, local Supabase)" job runs the cross-user isolation suite against `supabase start`.

## Phases (each ships green; order is auth → data → storage → deletion → cutover)

### A. Identity → qavren-auth (Keycloak realm `recharacter`)

- Provision the realm; email/password flow to match current UX (no magic links — checklist §7 keeps that deferred).
- Replace `@supabase/ssr` session handling: OIDC code flow, session cookie, middleware refresh → Keycloak tokens. `auth.getUser()` call sites collapse to one `getSessionUser()` helper.
- Schema: `owner_id` FKs to `auth.users` become plain `uuid` columns (Keycloak `sub`). One migration; no data transform beyond dropping the FK.

### B. Data → qavren-db schema `recharacter`

- `pwsh tools/provision-app.ps1 -App recharacter -Env test -Apply`, then prod. Store printed URLs/password in repo GitHub secrets immediately (`DATABASE_URL` pooler for runtime, session URL for migrations).
- Rewrite 0001–0008 as plain-Postgres DDL in the `recharacter` schema (Drizzle migrations; `prepare: false` on the pooler). No RLS, no grants — the app role owns the schema and nothing else.
- Swap supabase-js data access → Drizzle over `DATABASE_URL`. The `lib/*.ts` data modules (cases, facts, drafts, nexus, billing, context, account) are the seam; server actions/routes stay shaped as-is.
- **Security invariant that replaces RLS:** every query scopes by `owner_id = session.sub` in code. The Plan-02 cross-user access test suite MUST survive the re-platform as the CI gate (see G) — schema-role isolation walls apps off from each other, not users within this app.

### C. Storage → R2

- Bucket `recharacter-case-documents`; keep the `{user}/{case}/{uuid}-{name}` key convention.
- Upload via S3 API server-side (already server-mediated); reads are server-only today (extraction, export) — no public URLs needed.
- Storage RLS policies die with the bucket; the owner-scoping invariant (B) covers access.

### D. Deletion & export rewrite (kills the service-role key)

- Export: SQL selects over the user's rows (same JSON shape as today) + R2 object list.
- Deletion: delete user's rows (own schema, plain SQL) → R2 prefix delete → Keycloak admin user-delete via qavren-auth realm admin credentials (server-side, realm-scoped — not a database superkey). Fails closed on the Keycloak step, same posture as today.

### E. Unchanged

Rules engine + routing API (no data), AI gateway/tasks/limits (ai_usage moves schemas but queries port 1:1 in B), Stripe/billing logic, packet assembly, the wizard UI.

### F. Cutover — DECISION NEEDED (Steve)

Founder-testing data only in `ldxgdceplsdycviroisd`: **fresh provision + re-onboard** (playbook line as written), or playbook §2–§4 copy (snapshot → rename to `recharacter` schema → verify counts/checksums)? Fresh is simpler; copy is ~an hour more. Either way: 7-day read-only retention on the old project before deletion, per playbook §6.
- Box `.env` after cutover: drop `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`; add `DATABASE_URL`, R2 creds, Keycloak client secret. `AI_*`, `ANTHROPIC_API_KEY`, `AI_KEY_ENCRYPTION_SECRET`, `TUNNEL_TOKEN` unchanged.

### G. CI

- Replace the local-Supabase RLS job with a Postgres service container running the Drizzle migrations + the cross-user scoping suite + (new) an app-role isolation smoke against a second schema, mirroring qavren-db's Pester posture.

## Order & risk

A before B (auth.users FKs must go before the schema moves). C/D after B. Biggest risk: the RLS→code-scoping swap (B) — mitigated by porting the existing cross-user tests before any query swap lands. Second: Keycloak session UX parity — mitigated by keeping the (auth) route shapes and testing the middleware refresh path explicitly.

## Interim note

Until D ships, account deletion on recharacter.us requires `SUPABASE_SERVICE_ROLE_KEY` on the box (verified missing 2026-07-11; one-liner fix staged in the launch-checklist thread). Ship the key or accept broken deletion for the interim — Steve's call.

## 2026-08-02 — Phase A's platform side now exists

qavren-auth PR #83 provisions the `recharacter` realm: email/password only
(no IdPs, deliberately — see the privacy note in the realm file),
self-registration on, password reset on (net-new capability — the app has no
reset flow on Supabase), clients `recharacter-web` (public PKCE),
`recharacter-web-confidential` (first consumer of the auth-next confidential
opt-in, qavren-auth #68 — justified by this plan's own "all server-side"
recon), and `recharacter-admin-svc` (`manage-users` only, backs §D). Both
client secrets are generated and staged in
`D:\recharacter-credentials-vault-20260802\` with push commands in its
README; the realm reaches prod on the next `-AllRealms` apply. Phase A app
work can start any time after that.

**§F recommendation (decision still Steve's): fresh provision + re-onboard.**
Three facts from the 2026-08-02 repo recon make copy-mode pure cost here:
founder-testing data only; Stripe not live, so `entitlements.owner_id` has no
real payments to remap (the UUID→`sub` crosswalk problem evaporates if the
cutover lands before Stripe does — after that it's permanent); and password
hashes wouldn't survive any copy anyway (GoTrue bcrypt is exportable, but
with a handful of founder accounts re-registering beats building the import
path). Keep playbook §6's 7-day read-only retention either way.

Two §B/§D reminders that earned their place (recon 2026-08-02):
- `ai_usage` and `entitlements` are insert-only BY DESIGN — today the
  `auth.users` FK cascade is the only thing that clears them on account
  deletion. §D's rewrite must land in the same phase that drops the FKs or
  the legal-posture one-click-delete promise breaks silently.
- The eight `web/tests/*-rls.integration.test.ts` suites are the isolation
  guarantee's only safety net after RLS dies. Port them before swapping any
  query (§B as written).
