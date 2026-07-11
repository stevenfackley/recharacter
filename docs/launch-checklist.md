# Launch checklist

Everything between code-complete (all 8 roadmap plans merged) and public launch. Ordered roughly by dependency. Items marked **HUMAN** cannot be done by the pipeline.

**Status 2026-07-11: the app is LIVE at recharacter.us** (production push 2026-07-07; runbook: `docs/deploy.md`). Remaining items are launch gates, hardening, and accepted-gap decisions — not feature work.

## 1. Verification gates

- [x] Live end-to-end smoke test — done 2026-07-06 with a **synthetic** DD-214 (issue #9; findings fixed in PR #16). Deterministic flow verified and real-model AI verified: extraction read the synthetic DD-214 4-for-4, `shape_nexus_answer` preserved voice.
- [ ] **HUMAN — Founder's real-DD-214 run + statement-quality judgment.** Steve's own case is the first real test case by design; the 07-06 pass used synthetic records. Walk the full path on production: upload → extraction quality → confirm → routing correctness → evidence → nexus ("Help me phrase this") → statement generation quality → packet PDF.
- [ ] **HUMAN — Attorney review.** Work `docs/legal-review-package.md` §1–§9 to sign-off. Hard launch gate per `docs/legal-posture.md`.
- [ ] Draft-quality evaluation pass: generate statements from several synthetic fact patterns (each branch, MST case, GCM case) and read them against the prompts' rules (no invented facts, no advice). Tune prompts if needed — they're all in one file (`web/src/lib/ai/tasks.ts`).

## 2. Product gaps accepted at MVP (decide: fix now or ship without)

- [x] One-click data delete/export (`docs/legal-posture.md` promises it) — shipped 2026-07-10 (PR #17, deployed): Settings → Your data (`/settings/data`); export is RLS-scoped JSON, deletion sweeps storage then cascades via `auth.admin.deleteUser`.
- [ ] **Verify `SUPABASE_SERVICE_ROLE_KEY` is set in the prod box `.env`** (see `deploy/env.example`) — account deletion fails closed without it. Flagged at PR #17 merge; not yet confirmed on the box.
- [ ] Requested-characterization field in intake (worksheet currently renders bracketed guidance).
- [ ] Document list/delete UI for uploaded records (bucket + policies exist; no UI).
- [x] `source` provenance loss on confirm (`confirmFacts` always writes `manual`) — fixed 2026-07-11 (PR #20): confirming untouched extracted values keeps `source: 'extracted'` (still `confirmed: true`); any edit or first manual entry records `manual`. Gate restructured: `saveServiceFacts` writes only unconfirmed rows, `confirmServiceFacts` is the sole confirmer and derives provenance itself.
- [ ] Draft-page UX without an AI key: veteran can paste/write a statement manually — verify the flow reads acceptably.

## 3. Infrastructure — live at recharacter.us

- [x] Cloud Supabase project (`recharacter`, us-east-1, Steve's Database Org): provisioned, migrations 0001–0008 pushed, storage bucket + policies. Migration 0008 added explicit `service_role` grants — third occurrence of the CI-vs-local ACL lesson (never rely on default privileges).
- [ ] Auth email polish: custom SMTP + templates/sending domain (currently Supabase default SMTP — fine for smoke, not for public traffic).
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

- [ ] Error tracking (Sentry is already in the workspace toolbox) + uptime checks on web, routing API, Supabase.
- [x] Managed-tier cost guardrails — shipped 2026-07-11: hard per-user daily token cap on non-BYOK calls at the gateway (`AI_MANAGED_DAILY_TOKEN_CAP`, default 2M/UTC day). Aggregate spend *alerting* on `ai_usage` is still open (fold into the Sentry/uptime item).
- [ ] Backups/retention: Supabase PITR settings; the retention policy the privacy copy promises.
- [x] Rate limiting on `/api/ai/*` — shipped 2026-07-11: per-user sliding window in `executeAiTask` (`AI_RATE_LIMIT_PER_MINUTE`, default 10/min) — covers the API route AND server actions, BYOK included.

## 6. Content

- [x] Landing page — shipped 2026-07-06 (PR #10): "records office" identity, re-stamp hero, DRAFT terms + privacy pages.
- [ ] **HUMAN + attorney:** ToS + Privacy Policy final copy (DRAFT pages exist in-app), marketing-site copy, in-app footer disclaimer, packet cover-page disclaimer.
- [ ] The domain primer's Wilkie-date verification lands with the attorney pass.

## 7. Post-launch roadmap seeds (from plan Notes sections)

Buddy-statement/nexus-letter request templates · coordinate-overlay form filling (07b; re-scout first) · multi-case support (drop `cases_one_per_owner`) · magic-link auth · Coast Guard verification pass · VSO/attorney referral resources page.
