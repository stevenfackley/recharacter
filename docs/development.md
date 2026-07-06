# Development

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| .NET SDK | 10.x | solution file is the newer `ReCharacter.slnx` format — all `dotnet` commands handle it transparently |
| Node.js | 22+ | repo developed on v26 |
| Docker Desktop | running | required by local Supabase |
| Supabase CLI | 2.x | `supabase --version` |

## First-time setup

```bash
git clone https://github.com/stevenfackley/recharacter && cd recharacter

# .NET
dotnet build && dotnet test          # 20+ rules-engine tests + API integration tests

# Supabase (from repo root — config lives in supabase/)
supabase start                       # first run pulls Docker images; takes minutes
supabase status -o env               # prints API_URL / ANON_KEY / SERVICE_ROLE_KEY

# Web
cd web
cp .env.example .env.local           # fill the three values from `supabase status -o env`
npm install
npm run dev                          # http://localhost:3000
```

`web/.env.local` values:

| Var | Source | Shipped to browser? |
|-----|--------|---------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | `API_URL` | yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` (the JWT, not the newer `sb_publishable_` key) | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` | **no — tests only**, used to provision test users |
| `ANTHROPIC_API_KEY` | your key (Plan 03+) | no |
| `AI_KEY_ENCRYPTION_SECRET` | `openssl rand -base64 32` (Plan 03+) | no |

**Never commit `.env.local`.** Only `web/.env.example` (no secrets) is tracked; `web/.gitignore` carries an explicit `!.env.example` exception.

## Everyday commands

```bash
dotnet test                                  # all .NET tests
dotnet run --project src/ReCharacter.RoutingApi   # routing API (POST /route)

cd web
npx vitest run src                           # unit tests only (no Supabase needed)
npx vitest run                               # everything incl. RLS integration (Supabase must be up)
npm run build                                # production build

supabase db reset                            # re-apply all migrations (wipes local data)
```

## Database migrations

Add a numbered file under `supabase/migrations/` (e.g. `0003_ai.sql`), then `supabase db reset`. **Every new table must**: enable RLS, define owner-scoped policies, **grant table privileges explicitly** (`grant ... to authenticated` — schema default privileges vary by CLI/image version and CI runs latest; Postgres checks GRANTs *before* RLS), and gain a two-user isolation test in `web/tests/` before it ships.

## Known gotchas

- **Kong flake after `supabase db reset`:** the API gateway container occasionally comes up wedged (Node fetches fail with "socket other side closed" while `docker ps` says healthy). Fix: `docker restart supabase_kong_recharacter`, then rerun tests.
- **`supabase db execute` doesn't exist** in CLI 2.90 — use `supabase db query "..."` for ad-hoc SQL.
- **`supabase status` shows `sb_publishable_`/`sb_secret_` keys by default** — the app uses the legacy JWT keys; get them via `supabase status -o env` (`ANON_KEY` / `SERVICE_ROLE_KEY`).
- **Next 16 deprecation warning:** the repo scaffolded on Next 16, which deprecates `middleware.ts` in favor of `proxy.ts`. The current `web/src/middleware.ts` works (build shows `ƒ Proxy (Middleware)`) but warns; a rename is queued.
- **Windows line endings:** a workspace hook auto-normalizes CRLF flips; if you see phantom whole-file diffs, that's what happened.
- **Turbopack workspace-root warning:** silenced via `turbopack.root` in `web/next.config.ts` (a stray lockfile in the home directory confuses inference).

## CI

`.github/workflows/ci.yml` runs three jobs on every PR: **rules-engine** (`dotnet test`), **web** (build + unit tests, no Supabase), and **web-integration** (spins up local Supabase via `supabase/setup-cli` and runs the full Vitest suite including RLS isolation).

## Conventions

- Conventional Commits; **never commit to `main`** — feature branch → PR → squash.
- No AI/Co-Authored-By attribution in commit messages.
- TDD for engine and gateway code; every plan's tasks commit one at a time.
- Plans live in `docs/superpowers/plans/`, written just-in-time per the roadmap.
