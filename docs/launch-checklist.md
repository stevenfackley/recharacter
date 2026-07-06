# Launch checklist

Everything between code-complete (all 8 roadmap plans merged) and public launch. Ordered roughly by dependency. Items marked **HUMAN** cannot be done by the pipeline.

## 1. Verification gates

- [ ] **HUMAN — Live end-to-end smoke test.** Add `ANTHROPIC_API_KEY` to `web/.env.local`, run the .NET routing service (`dotnet run --project src/ReCharacter.RoutingApi`) + `npm run dev` + `supabase start`, then walk the full path with a REAL DD-214: upload → extraction quality → confirm → routing correctness → evidence → nexus (try "Help me phrase this") → statement generation quality → packet PDF. **The model has never actually been called** — every AI code path is mock-verified only. Founder's own case is the first test case by design.
- [ ] **HUMAN — Attorney review.** Work `docs/legal-review-package.md` §1–§9 to sign-off. Hard launch gate per `docs/legal-posture.md`.
- [ ] Draft-quality evaluation pass: generate statements from several synthetic fact patterns (each branch, MST case, GCM case) and read them against the prompts' rules (no invented facts, no advice). Tune prompts if needed — they're all in one file (`web/src/lib/ai/tasks.ts`).

## 2. Product gaps accepted at MVP (decide: fix now or ship without)

- [ ] One-click data delete/export (`docs/legal-posture.md` promises it; not yet built).
- [ ] Requested-characterization field in intake (worksheet currently renders bracketed guidance).
- [ ] Document list/delete UI for uploaded records (bucket + policies exist; no UI).
- [ ] `source` provenance loss on confirm (`confirmFacts` always writes `manual`).
- [ ] Draft-page UX without an AI key: veteran can paste/write a statement manually — verify the flow reads acceptably.

## 3. Infrastructure (nothing is deployed anywhere)

- [ ] Cloud Supabase project: provision, push migrations 0001–000N, **verify grants/revokes/RLS behave identically** (the CI-vs-local ACL lesson says: never assume), enable storage bucket + policies, auth email templates/domain.
- [ ] Host the Next.js app (env: Supabase keys, `ANTHROPIC_API_KEY`, `AI_KEY_ENCRYPTION_SECRET` — generate a production KEK and store it in a secrets manager; rotation story is a known gap), `APP_BASE_URL`.
- [ ] Deploy the .NET routing API (container; it's stateless — anything works) + set `ROUTING_API_URL`.
- [ ] CI → CD: current workflows test only; add deploy jobs when hosting is chosen (workspace convention: OIDC, not static keys).
- [ ] Domain + TLS. **HUMAN: trademark/domain check for "ReCharacter"** (mirrors Reclaim's naming caveat — never done).

## 4. Payments (code exists; commerce doesn't)

- [ ] **HUMAN — Stripe account + live product/price** (pricing decision: "intentionally low" per spec; the code reads `STRIPE_PRICE_ID`).
- [ ] Test-mode end-to-end checkout → entitlement → premium unlock; then live-mode smoke.
- [ ] Post-MVP hardening queue: webhook fulfillment (belt over the redirect-verification suspenders), refund handling.

## 5. Ops & safety

- [ ] Error tracking (Sentry is already in the workspace toolbox) + uptime checks on web, routing API, Supabase.
- [ ] Managed-tier cost guardrails: `ai_usage` is metering — add an alert threshold (runaway extraction/drafting spend) before public traffic.
- [ ] Backups/retention: Supabase PITR settings; the retention policy the privacy copy promises.
- [ ] Rate limiting on `/api/ai/*` (currently none beyond auth + entitlement — a hostile authed user could burn managed tokens on extraction, which is free-tier).

## 6. Content

- [ ] **HUMAN + attorney:** ToS, Privacy Policy, marketing-site copy, in-app footer disclaimer, packet cover-page disclaimer.
- [ ] Landing page (nothing exists outside the app shell).
- [ ] The domain primer's Wilkie-date verification lands with the attorney pass.

## 7. Post-launch roadmap seeds (from plan Notes sections)

Buddy-statement/nexus-letter request templates · coordinate-overlay form filling (07b; re-scout first) · multi-case support (drop `cases_one_per_owner`) · magic-link auth · Coast Guard verification pass · VSO/attorney referral resources page.
