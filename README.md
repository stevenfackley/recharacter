# ReCharacter

**Self-help web app that helps U.S. veterans upgrade less-than-honorable discharges.**

ReCharacter walks a veteran through building a **mental-health-based discharge-upgrade petition** under the military's *liberal consideration* policy (Hagel 2014 / Kurta 2017 / Wilkie 2017): it routes them to the correct review board and form, interviews them to construct the nexus argument, drafts the supporting statement with AI assistance, coaches them on evidence gaps, and exports a **ready-to-file packet that the veteran owns and submits themselves**.

> **Posture:** document assembly + information — **never legal advice**. The app never represents a veteran before a board. See [`docs/legal-posture.md`](docs/legal-posture.md).

## Status

| Plan | Scope | Status |
|------|-------|--------|
| 01 | Rules engine + routing API (.NET) | ✅ Merged — 22 tests |
| 02 | Auth & persistence (Next.js + Supabase RLS) | ✅ Built — 7 tests, in review |
| 03 | AI gateway (managed proxy + BYOK) | 📝 Drafted |
| 04–08 | Intake/extraction · Evidence/coaching · Nexus/draft · Packet export · Billing | Roadmap |

Full roadmap: [`docs/superpowers/plans/2026-07-05-recharacter-ROADMAP.md`](docs/superpowers/plans/2026-07-05-recharacter-ROADMAP.md)

## Architecture

```
┌────────────────────────── Next.js (web/) ──────────────────────────┐
│  Wizard UI · Auth · AI gateway (bounded tasks) · Packet assembly   │
│  Stripe billing · all application state                            │
└──────────┬──────────────────────┬──────────────────────┬───────────┘
           │ RLS-scoped SQL       │ HTTPS                │ HTTP POST /route
           ▼                      ▼                      ▼
   Supabase (Postgres +    Anthropic API         ReCharacter.RoutingApi (src/)
   Auth + Storage, RLS     (managed key or       stateless .NET service wrapping
   on every table)         user's BYOK key)      the pure RulesEngine library
```

- **`src/` — .NET routing service.** A pure, exhaustively-tested library (`ReCharacter.RulesEngine`) that maps discharge facts → review board (DRB vs BCMR), form (DD-293 vs DD-149), the 15-year DRB filing deadline, and advisory flags — wrapped in a minimal API. Deterministic, stateless, no database. A bug here means a veteran misses a filing window, so it is the most heavily tested code in the repo.
- **`web/` — Next.js app.** Owns everything stateful. Every AI call goes through a single gateway route with a registry of bounded tasks (fixed prompts, schema-validated output) — there are no free-form AI endpoints.
- **`supabase/` — migrations.** Every table is owner-scoped with row-level security; isolation is proven by two-user integration tests, not assumed.

Details: [`docs/architecture.md`](docs/architecture.md) · Design spec: [`docs/superpowers/specs/2026-07-05-recharacter-design.md`](docs/superpowers/specs/2026-07-05-recharacter-design.md)

## Quickstart

Prereqs: .NET 10 SDK, Node 22+, Docker Desktop, Supabase CLI. Full setup: [`docs/development.md`](docs/development.md).

```bash
# Rules engine + routing API
dotnet test                                  # all .NET tests
dotnet run --project src/ReCharacter.RoutingApi

# Web app
supabase start                               # local Postgres/Auth stack (from repo root)
cd web
cp .env.example .env.local                   # then fill values from `supabase status -o env`
npm install
npm run dev                                  # http://localhost:3000
npx vitest run                               # unit + RLS integration tests
```

## Domain primer

If board names like NDRB/BCNR, DD-293 vs DD-149, or the Kurta memo's four questions are unfamiliar, start at [`docs/domain/discharge-upgrades.md`](docs/domain/discharge-upgrades.md) — the curated legal/domain knowledge the product is built on.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`docs/architecture.md`](docs/architecture.md) | System boundaries, data flow, key decisions |
| [`docs/development.md`](docs/development.md) | Environment setup, commands, known gotchas |
| [`docs/domain/discharge-upgrades.md`](docs/domain/discharge-upgrades.md) | Boards, forms, deadlines, liberal consideration |
| [`docs/legal-posture.md`](docs/legal-posture.md) | The self-help boundary and how the code enforces it |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Approved design spec |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Roadmap + per-plan implementation plans |

## License

Proprietary. © Steven Ackley. All rights reserved.
