# ReCharacter

**Self-help web app that helps U.S. veterans upgrade less-than-honorable discharges.**

ReCharacter walks a veteran through building a **mental-health-based discharge-upgrade petition** under the military's *liberal consideration* policy (Hagel 2014 / Kurta 2017 / Wilkie 2017): it routes them to the correct review board and form, interviews them to construct the nexus argument, drafts the supporting statement with AI assistance, coaches them on evidence gaps, and exports a **ready-to-file packet that the veteran owns and submits themselves**.

> **Posture:** document assembly + information — **never legal advice**. The app never represents a veteran before a board. See [`docs/legal-posture.md`](docs/legal-posture.md).

## Status

| Plan | Scope | Status |
|------|-------|--------|
| 01 | Rules engine + routing API (.NET) | ✅ Merged |
| 02 | Auth & persistence (Keycloak via qavren-auth + Postgres schema on qavren-db, owner-scoped queries) | ✅ Merged — re-platformed by 09 |
| 03 | AI gateway (managed proxy + BYOK) | ✅ Merged |
| 04–08 | Intake/extraction · Evidence/coaching · Nexus/draft · Packet export · Billing | ✅ Merged 2026-07-06 |
| 09 | Re-platform onto qavren-auth + qavren-db + R2 | ✅ Built — pending cutover |

Full roadmap: [`docs/superpowers/plans/2026-07-05-recharacter-ROADMAP.md`](docs/superpowers/plans/2026-07-05-recharacter-ROADMAP.md)

## Architecture

```
┌────────────────────────── Next.js (web/) ──────────────────────────┐
│  Wizard UI · Auth · AI gateway (bounded tasks) · Packet assembly   │
│  Stripe billing · all application state                            │
└──────┬─────────────────┬──────────────────┬──────────────┬─────────┘
       │ OIDC             │ owner-scoped SQL │ S3 API        │ HTTP POST /route
       ▼                  ▼                  ▼               ▼
qavren-auth        qavren-db (Postgres,  Cloudflare R2   ReCharacter.RoutingApi (src/)
(Keycloak realm     schema recharacter)  (case-documents) stateless .NET service
recharacter)        owner_id-scoped                       wrapping the pure
                     queries, no RLS                       RulesEngine library
```

- **`src/` — .NET routing service.** A pure, exhaustively-tested library (`ReCharacter.RulesEngine`) that maps discharge facts → review board (DRB vs BCMR), form (DD-293 vs DD-149), the 15-year DRB filing deadline, and advisory flags — wrapped in a minimal API. Deterministic, stateless, no database. A bug here means a veteran misses a filing window, so it is the most heavily tested code in the repo.
- **`web/` — Next.js app.** Owns everything stateful. Every AI call goes through a single gateway route with a registry of bounded tasks (fixed prompts, schema-validated output) — there are no free-form AI endpoints.
- **`web/drizzle/` — migrations.** Plain Postgres DDL against the `recharacter` schema on qavren-db. Every table is owner-scoped in code (`owner_id = session user` on every statement); isolation is proven by two-user integration tests, not assumed.

Details: [`docs/architecture.md`](docs/architecture.md) · Design spec: [`docs/superpowers/specs/2026-07-05-recharacter-design.md`](docs/superpowers/specs/2026-07-05-recharacter-design.md)

## Quickstart

Prereqs: .NET 10 SDK, Node 22+, Docker Desktop. Full setup: [`docs/development.md`](docs/development.md).

```bash
# Rules engine + routing API
dotnet test                                  # all .NET tests
dotnet run --project src/ReCharacter.RoutingApi

# Web app
docker compose -f compose.dev.yaml up -d    # local Postgres 17 + MinIO (from repo root)
cd web
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev                                  # http://localhost:3000 — signs in against the live Keycloak realm
npx vitest run src                           # unit tests
npx vitest run tests                         # owner-scoping integration tests (needs the stack up)
```

## Domain primer

If board names like NDRB/BCNR, DD-293 vs DD-149, or the Kurta memo's four questions are unfamiliar, start at [`docs/domain/discharge-upgrades.md`](docs/domain/discharge-upgrades.md) — the curated legal/domain knowledge the product is built on.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`docs/architecture.md`](docs/architecture.md) | System boundaries, data flow, key decisions |
| [`docs/development.md`](docs/development.md) | Environment setup, commands, known gotchas |
| [`docs/deploy.md`](docs/deploy.md) | Production deployment, secrets, cutover runbook, smoke checklist |
| [`docs/domain/discharge-upgrades.md`](docs/domain/discharge-upgrades.md) | Boards, forms, deadlines, liberal consideration |
| [`docs/legal-posture.md`](docs/legal-posture.md) | The self-help boundary and how the code enforces it |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Approved design spec |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Roadmap + per-plan implementation plans |

## License

Proprietary. © Steven Ackley. All rights reserved.
