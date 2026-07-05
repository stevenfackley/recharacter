# ReCharacter — Implementation Roadmap

**Source spec:** `docs/superpowers/specs/2026-07-05-recharacter-design.md`
**Date:** 2026-07-05

This roadmap decomposes ReCharacter into sequenced plans. **Each plan ships working, testable software on its own.** Only **Plan 01 is written in full** (see `2026-07-05-recharacter-01-rules-engine.md`); later plans are detailed just-in-time, right before execution, because their interfaces firm up as earlier plans land.

## Architecture recap (concrete boundaries)

- **.NET** is a **stateless routing service** — the `ReCharacter.RulesEngine` library (pure board/form/deadline logic) wrapped in a thin ASP.NET minimal API. It holds **no data** and knows nothing about users.
- **Next.js** owns everything stateful: the wizard UI, persistence (via Supabase), the AI gateway (managed proxy + BYOK), packet assembly (pdf-lib), and billing (Stripe). It **calls the .NET routing service over HTTP** with extracted discharge facts.
- **Supabase** is Postgres + RLS + Auth + Storage.

This keeps the one component where a bug = a missed filing deadline (routing/deadlines) small, pure, and exhaustively tested in isolation.

## Plan sequence

| # | Plan | Ships | Depends on | Top risk |
|---|------|-------|------------|----------|
| 01 | **Rules Engine + Routing API** (.NET) | A callable service: facts → board + form + deadline + flags | — | 15-year DRB boundary math |
| 02 | **App shell, Auth & Persistence** (Next.js + Supabase) | Signed-in user with an empty, RLS-isolated Case + wizard scaffold | — (parallel to 01) | RLS correctness |
| 03 | **AI Gateway** (Next.js server routes) | Bounded Claude calls via managed proxy **and** BYOK, metered | 02 | key custody, cost controls |
| 04 | **Intake & Document Extraction** | Upload records → structured `ServiceFacts` → routing result shown | 01, 02, 03 | extraction accuracy, PII handling |
| 05 | **Evidence Checklist & Coaching** | Personalized checklist + case-strength score + top-gap callout | 04 | scoring-rubric validity |
| 06 | **Nexus Builder & Draft** | Kurta 4-question interview → drafted statement + cover letter | 03, 04 | draft quality, UPL boundedness |
| 07 | **Packet Assembly & Export** | Filled DD-293/DD-149 + assembled, downloadable packet PDF | 05, 06 | official-form fidelity |
| 08 | **Billing & Freemium Gating** | Free through checklist; Stripe-gated drafting + packet | 03, 06, 07 | gating correctness, payment edges |

The wizard UI is built incrementally: its shell lands in Plan 02, and Plans 04–07 each add their step.

## Why this order

1. **01 and 02 are independent** and can run in parallel — one is pure .NET logic, the other is the Next.js/Supabase foundation. Both are pure infrastructure with no AI, so they're the safest, most testable starting points.
2. **03 (AI gateway) before any AI feature** — every AI-using plan (04, 06) depends on a single, metered, bounded gateway. Build it once, correctly, with the anti-UPL guardrails centralized.
3. **04 before 05/06** — intake produces the structured facts everything downstream reasons over.
4. **07 (packet) late** — it assembles the outputs of 05 and 06; nothing depends on it.
5. **08 (billing) last** — gating is meaningless until there's a valuable thing (drafting, packet) to gate.

## Per-plan acceptance ("done when")

- **01:** `POST /route` returns correct board/form/deadline/flags for every branch and the DRB-window boundary cases; all rules-engine unit tests + one API integration test green.
- **02:** a user can sign up, sign in, and see exactly their own Case (RLS proven by a cross-user access test); empty wizard renders.
- **03:** a bounded prompt round-trips through both managed-proxy and BYOK paths (provider mocked in tests); token usage is recorded.
- **04:** a veteran uploads a DD-214 photo and sees extracted facts + the correct routing result.
- **05:** the app renders a personalized evidence checklist and a case-strength score with the single highest-leverage gap named.
- **06:** the four Kurta answers produce a drafted personal statement + cover letter quoting the veteran's own words.
- **07:** the app exports a single PDF: filled DD form + statement + cover + evidence index + buddy-statement templates.
- **08:** free tier reaches the checklist; drafting + packet require a paid entitlement or a valid BYOK key; managed usage is metered.

## Deferred (not a plan until legal review)

- Attorney sign-off on disclaimer/positioning copy (hard launch gate).
- Coast Guard rollout verification (DHS policy differs).
- Assisted certified-mail submission (Lob), file-on-behalf — out of scope by design.
