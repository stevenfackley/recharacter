# Development

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| .NET SDK | 10.x | solution file is the newer `ReCharacter.slnx` format — all `dotnet` commands handle it transparently |
| Node.js | 22+ | repo developed on v26 |
| Docker Desktop | running | required by `compose.dev.yaml` (local Postgres + MinIO) |

## First-time setup

```bash
git clone https://github.com/stevenfackley/recharacter && cd recharacter

# .NET
dotnet build && dotnet test          # 20+ rules-engine tests + API integration tests

# Local stack (from repo root) — Postgres 17 on :55433, MinIO on :9000 (console :9001)
docker compose -f compose.dev.yaml up -d

# Web
cd web
cp .env.example .env.local
npm ci
npm run db:migrate                   # applies web/drizzle/*.sql to the local Postgres
npm run dev                          # http://localhost:3000
```

`web/.env.local` values:

| Var | Source | Notes |
|-----|--------|-------|
| `DATABASE_URL` | `postgres://recharacter:recharacter@127.0.0.1:55433/recharacter` | local Postgres from `compose.dev.yaml` |
| `AUTH_SECRET` | `openssl rand -base64 32` | Auth.js cookie encryption — must be set locally too |
| `AUTH_URL` / `APP_BASE_URL` | `http://localhost:3000` | `http://localhost:3000/*` is an allowed redirect URI on the `recharacter-web` Keycloak client |
| `QAVREN_AUTH_URL` | `https://auth.recharacter.us` | local dev signs in against the **live** Keycloak realm — there is no local Keycloak |
| `S3_ENDPOINT` | `http://127.0.0.1:9100` | routes the R2 client at local MinIO instead |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_ACCOUNT_ID` | `minio` / `minio12345` / `recharacter-dev` / `local` | MinIO credentials from `compose.dev.yaml` |
| `ANTHROPIC_API_KEY` | your key (Plan 03+) | server only |
| `AI_KEY_ENCRYPTION_SECRET` | `openssl rand -base64 32` (Plan 03+) | server only |

**Never commit `.env.local`.** Only `web/.env.example` (no secrets) is tracked; `web/.gitignore` carries an explicit `!.env.example` exception.

Because local dev signs in against the live realm, **create a throwaway account** on first run (`/login` → registration link → Keycloak's hosted page) rather than reusing a real one.

## Everyday commands

```bash
dotnet test                                       # all .NET tests
dotnet run --project src/ReCharacter.RoutingApi   # routing API (POST /route)

cd web
npx vitest run src                                # unit tests (no stack needed)
npx vitest run tests                              # owner-scoping integration tests (stack must be up)
npm run lint
npx tsc --noEmit
npm run build                                     # production build

npm run db:generate                               # drizzle-kit generate — new migration from schema.ts changes
npm run db:migrate                                # apply pending migrations (tsx scripts/migrate.ts)
```

## Database migrations

Add/edit tables in `web/src/db/schema.ts`, run `npm run db:generate` to emit a new file under `web/drizzle/`, then `npm run db:migrate`. Every new owner-scoped table needs a case in the matching `web/tests/*-scoping.integration.test.ts` suite before it ships — there is no RLS to fall back on (see `docs/architecture.md` § Owner-scoping invariant).

## Known gotchas

- **`CREATE SCHEMA IF NOT EXISTS` still 42501s for the app role.** Postgres checks database-level `CREATE` privilege *before* it honours `IF NOT EXISTS` on `CREATE SCHEMA` — so even though the qavren-db `recharacter` role owns the `recharacter` schema outright, it has no `CREATE` on the database, and drizzle-orm's stock `migrate()` unconditionally issues that statement for its own bookkeeping schema. That's why `web/scripts/migrate.ts` doesn't call drizzle's `migrate()`; it drives the same apply loop by hand (same `__drizzle_migrations` ledger, hashes, and ordering — just created *inside* the `recharacter` schema, and only when genuinely absent).
- **`SET LOCAL` is required to delete ledger rows.** `ai_usage` and `entitlements` have a trigger that raises `42501` on `UPDATE`/`DELETE` unless the transaction first runs `SET LOCAL recharacter.allow_ledger_delete = 'on'`. Only account deletion does this; everywhere else the ledgers are genuinely append-only. Tests that need to seed/clean these tables directly must wrap the statement the same way (`web/tests/helpers.ts` → `allowLedgerDelete`).
- **`prepare: false` is mandatory at runtime.** `DATABASE_URL` points at qavren-db's Supavisor transaction pooler (`:6543`), which doesn't support prepared statements across pooled connections; `web/src/db/index.ts` sets `prepare: false` on the postgres-js client. Migrations use the session-mode URL (`DATABASE_URL_MIGRATE`, `:5432`) instead, because the transaction pooler can't hold the advisory lock a migrator needs.
- **Next 16 middleware naming:** Next 16 deprecates `middleware.ts` in favor of `proxy.ts`; this repo already uses `web/src/proxy.ts` (build shows `ƒ Proxy (Middleware)`).
- **Windows line endings:** a workspace hook auto-normalizes CRLF flips; if you see phantom whole-file diffs, that's what happened.
- **Turbopack workspace-root warning:** silenced via `turbopack.root` in `web/next.config.ts` (a stray lockfile in the home directory confuses inference).

## CI

`.github/workflows/ci.yml` runs three jobs on every PR: **rules-engine** (`dotnet test`), **web** (build + unit tests, no database), and **web-integration** (Postgres 17 + MinIO service containers, `npm run db:migrate`, then the full Vitest suite including the owner-scoping isolation tests).

## Conventions

- Conventional Commits; **never commit to `main`** — feature branch → PR → squash.
- No AI/Co-Authored-By attribution in commit messages.
- TDD for engine and gateway code; every plan's tasks commit one at a time.
- Plans live in `docs/superpowers/plans/`, written just-in-time per the roadmap.
