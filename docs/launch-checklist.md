# Launch checklist

Everything between code-complete (all 8 roadmap plans merged) and public launch. Ordered roughly by dependency. Items marked **HUMAN** cannot be done by the pipeline.

**Status 2026-07-11: the app is LIVE at recharacter.us** (production push 2026-07-07; runbook: `docs/deploy.md`). Remaining items are launch gates, hardening, and accepted-gap decisions — not feature work.

## 1. Verification gates

- [x] Live end-to-end smoke test — done 2026-07-06 with a **synthetic** DD-214 (issue #9; findings fixed in PR #16). Deterministic flow verified and real-model AI verified: extraction read the synthetic DD-214 4-for-4, `shape_nexus_answer` preserved voice.
- [ ] **HUMAN — Founder's real-DD-214 run + statement-quality judgment.** Steve's own case is the first real test case by design; the 07-06 pass used synthetic records. Walk the full path on production: upload → extraction quality → confirm → routing correctness → evidence → nexus ("Help me phrase this") → statement generation quality → packet PDF.
- [ ] **HUMAN — Attorney review.** Work `docs/legal-review-package.md` §1–§9 to sign-off. Hard launch gate per `docs/legal-posture.md`.
- [x] Draft-quality evaluation pass — done 2026-07-11 (`docs/eval/2026-07-11-draft-quality.md`): 5 synthetic statements (Army/Navy/USMC/AF/SF incl. MST + GCM patterns) + 2 cover letters against the live model, each adversarially judged. 6/7 passed; the one failure (empty evidence list → "I have included evidence with this petition") is fixed and retested in PR #21.

## 2. Product gaps accepted at MVP (decide: fix now or ship without)

- [x] One-click data delete/export (`docs/legal-posture.md` promises it) — shipped 2026-07-10 (PR #17, deployed): Settings → Your data (`/settings/data`); export is RLS-scoped JSON, deletion sweeps storage then cascades via `auth.admin.deleteUser`.
- [x] Long-lived database superkey on the prod box — retired by the Plan 09 re-platform (2026-08-27): account deletion now runs through the `recharacter-admin-svc` Keycloak service account (`manage-users` only), not a database superkey. See the infra items below for the cutover secrets this introduces.
- [ ] Requested-characterization field in intake (worksheet currently renders bracketed guidance).
- [ ] Document list/delete UI for uploaded records (bucket + policies exist; no UI).
- [x] `source` provenance loss on confirm (`confirmFacts` always writes `manual`) — fixed 2026-07-11 (PR #20): confirming untouched extracted values keeps `source: 'extracted'` (still `confirmed: true`); any edit or first manual entry records `manual`. Gate restructured: `saveServiceFacts` writes only unconfirmed rows, `confirmServiceFacts` is the sole confirmer and derives provenance itself.
- [ ] Draft-page UX without an AI key: veteran can paste/write a statement manually — verify the flow reads acceptably.

## 3. Infrastructure — live at recharacter.us

- [x] Re-platformed onto the fleet convention (Plan 09, 2026-08-27): Keycloak realm `recharacter` on qavren-auth for identity, Postgres schema `recharacter` on qavren-db for data (owner-scoped queries, no RLS), Cloudflare R2 for case documents. Built and merged; cutover (below) is the remaining Steve-only step.
- [ ] **Cutover — R2**: create bucket `recharacter-case-documents` (private) + a scoped API token (Object Read & Write); put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in the box `.env`.
- [ ] **Cutover — qavren-db**: `pwsh tools/provision-app.ps1 -App recharacter -Env prod -RotatePassword`; `DATABASE_URL` (pooler, `:6543`) into the box `.env`; `DATABASE_URL_MIGRATE` (session, `:5432`) as a `gh secret set` on the repo (read only by the deploy workflow's `migrate` job).
- [ ] **Cutover — Keycloak admin secret**: `QAVREN_ADMIN_CLIENT_SECRET` on the box, same value as the qavren-auth box's `RECHARACTER_ADMIN_CLIENT_SECRET`; account deletion fails closed without it.
- [ ] **Cutover — Auth.js secrets**: `AUTH_SECRET` (`openssl rand -base64 32`) and `AUTH_URL=https://recharacter.us` on the box.
- [ ] Realm follow-up: consider `verifyEmail: true` on the `recharacter` Keycloak realm (qavren-auth repo change).
- [ ] Client follow-up: flip `recharacter-web` → confidential (`confidential: true` + `QAVREN_CLIENT_SECRET` against `recharacter-web-confidential`) once `@qavren/auth-next` ≥ 0.2.0 publishes.
- [ ] Delete the old Supabase project `ldxgdceplsdycviroisd` after its 7-day read-only retention window (paused, not deleted, at cutover).
- [ ] Cutover smoke: register on Keycloak's hosted page → upload a document → routing renders → packet generates → delete the account → confirm the user is gone from the Keycloak `recharacter` realm.
- [ ] Auth email polish: Keycloak realm mail config (templates/sending domain) — a qavren-auth concern, currently default SMTP; fine for smoke, not for public traffic.
- [x] Next.js app hosted: Qavren-Web-Server EC2, rootless Docker, Cloudflare Tunnel ingress (zero inbound ports on the box). All env set per `deploy/env.example`.
- [ ] `AI_KEY_ENCRYPTION_SECRET` (KEK) lives in the box `.env`, not a secrets manager; rotation story is still a known gap.
- [x] .NET routing API deployed (internal-only container on the compose network; `ROUTING_API_URL` wired).
- [x] CI → CD: `deploy.yml` builds both images → GHCR → SSH pull + `docker compose up -d` on every push to `main` (GHCR pull auth via workflow token, PR #14). SSH-key secrets, not OIDC — the workspace OIDC convention targets AWS API access; this is a box deploy.
- [x] Domain + TLS: recharacter.us via Cloudflare (registrar + DNS + proxy + tunnel).
- [ ] **HUMAN: trademark check for "ReCharacter"** (mirrors Reclaim's naming caveat — never done).

## 4. Payments (code exists; commerce doesn't)

- [ ] **HUMAN — Stripe account + live product/price** (pricing decision: "intentionally low" per spec; the code reads `STRIPE_PRICE_ID`).
- [ ] Test-mode end-to-end checkout → entitlement → premium unlock; then live-mode smoke.
- [ ] Post-MVP hardening queue: webhook fulfillment (belt over the redirect-verification suspenders), refund handling.

## 5. Ops & safety

- [ ] Error tracking (Sentry is already in the workspace toolbox) + uptime checks on web, routing API, qavren-db.
- [x] Managed-tier cost guardrails — shipped 2026-07-11: hard per-user daily token cap on non-BYOK calls at the gateway (`AI_MANAGED_DAILY_TOKEN_CAP`, default 2M/UTC day). Aggregate spend *alerting* on `ai_usage` is still open (fold into the Sentry/uptime item).
- [x] Backups: qavren-db runs nightly per-schema dumps to R2, platform-managed — no app-side setup.
- [ ] Retention: document the app-level retention policy the privacy copy promises.
- [x] Rate limiting on `/api/ai/*` — shipped 2026-07-11: per-user sliding window in `executeAiTask` (`AI_RATE_LIMIT_PER_MINUTE`, default 10/min) — covers the API route AND server actions, BYOK included.

## 6. Content

- [x] Landing page — shipped 2026-07-06 (PR #10): "records office" identity, re-stamp hero, DRAFT terms + privacy pages.
- [ ] **HUMAN + attorney:** ToS + Privacy Policy final copy (DRAFT pages exist in-app), marketing-site copy, in-app footer disclaimer, packet cover-page disclaimer.
- [ ] The domain primer's Wilkie-date verification lands with the attorney pass.

## 7. Post-launch roadmap seeds (from plan Notes sections)

Buddy-statement/nexus-letter request templates · coordinate-overlay form filling (07b; re-scout first) · multi-case support (drop `cases_one_per_owner`) · magic-link auth · Coast Guard verification pass · VSO/attorney referral resources page.
