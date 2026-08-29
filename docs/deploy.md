# Production deployment — recharacter.us

Architecture: **Qavren-Web-Server (existing EC2, rootless Docker)** runs `deploy/docker-compose.yml`
(web + routing + cloudflared). Ingress is a **Cloudflare Tunnel** — no inbound ports on the box,
TLS at Cloudflare (which is also the domain registrar). Identity is a **Keycloak realm** on
qavren-auth, data is a **Postgres schema** on qavren-db, and case documents live in a
**Cloudflare R2** bucket. Images live in **GHCR**, built and deployed by `.github/workflows/deploy.yml`
on every push to `main`.

```
Internet ──TLS──> Cloudflare (DNS+proxy) ──tunnel──> cloudflared ──> web:3000 ──> routing:8080
                                                                    │
                                                                    ├──OIDC──> qavren-auth (Keycloak, realm recharacter)
                                                                    ├──SQL───> qavren-db (Postgres, schema recharacter)
                                                                    ├──S3────> Cloudflare R2 (case-documents)
                                                                    └──HTTPS─> Anthropic API
```

## One-time setup

### 1. Cloudflare R2
1. Create a bucket, private, named `recharacter-case-documents`.
2. Create an R2 API token scoped to that bucket (Object Read & Write).
3. Copy `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` into the box `.env`.

### 2. qavren-db (Postgres, schema `recharacter`)
1. `cd C:\Users\steve\projects\qavren-db; pwsh tools/provision-app.ps1 -App recharacter -Env prod -RotatePassword` — the schema and role already exist on test and prod (provisioned empty); this rotates the role password and prints the connection strings.
2. Build `DATABASE_URL` (transaction pooler, `:6543`) and `DATABASE_URL_MIGRATE` (session mode, `:5432`) from the printed values.
3. `gh secret set DATABASE_URL_MIGRATE -R stevenfackley/recharacter` (the deploy workflow's `migrate` job reads it; it never touches the box).
4. Put `DATABASE_URL` in the box `.env`.

### 3. qavren-auth (Keycloak realm `recharacter`)
1. Confirm the auth box holds `RECHARACTER_ADMIN_CLIENT_SECRET` (its `compose.prod.yaml` refuses to start without it) — this is the secret for the `recharacter-admin-svc` service account (`manage-users` only).
2. Copy that same value into the box `.env` as `QAVREN_ADMIN_CLIENT_SECRET`. Account deletion fails closed without it.

### 4. Cloudflare Tunnel (dashboard)
1. Cloudflare Zero Trust → Networks → Tunnels → **Create a tunnel** (name: `recharacter`).
2. Copy the **tunnel token** into the box `.env` as `TUNNEL_TOKEN`.
3. Public hostname: `recharacter.us` → service `HTTP://web:3000` (add `www` too if wanted —
   the tunnel auto-creates the DNS records since Cloudflare is the registrar).

### 5. The box (Qavren-Web-Server, rootless docker)
Known quirks (from Qavren ops): rootless docker needs `loginctl enable-linger $USER` or pulls
die after logout; reach the box via `Qavren.pem` + public DNS (not Tailscale).

```bash
mkdir -p ~/recharacter && cd ~/recharacter
# GHCR is private: one-time login with a PAT that has read:packages
docker login ghcr.io -u stevenfackley
# Fetch the compose file (or scp it):
curl -fsSL https://raw.githubusercontent.com/stevenfackley/recharacter/main/deploy/docker-compose.yml -o docker-compose.yml
# ^ private repo: use `gh api` or scp instead if curl 404s.
curl -fsSL https://raw.githubusercontent.com/stevenfackley/recharacter/main/deploy/env.example -o env.example
cp env.example .env   # then fill every value (the contract below)
docker compose up -d
```

Box `.env` carries: `DATABASE_URL` (step 2), `AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_URL=https://recharacter.us`,
`QAVREN_AUTH_URL=https://auth.recharacter.us`, `QAVREN_ADMIN_CLIENT_SECRET` (step 3), the four `R2_*` vars (step 1),
`ANTHROPIC_API_KEY`, `AI_KEY_ENCRYPTION_SECRET` (`openssl rand -base64 32` — losing it just means BYOK users
re-enter keys), `APP_BASE_URL=https://recharacter.us`, `TUNNEL_TOKEN` (step 4). Full var-by-var contract:
`deploy/env.example`.

### 6. GitHub secrets (repo → Settings → Secrets → Actions)
| Secret | Value |
|---|---|
| `DEPLOY_HOST` | Qavren-Web-Server public DNS |
| `DEPLOY_USER` | the rootless-docker user on the box |
| `DEPLOY_SSH_KEY` | contents of `Qavren.pem` |
| `DATABASE_URL_MIGRATE` | qavren-db session-mode URL (`:5432`) — read only by the `migrate` job, never synced to the box |

## Every deploy after that

Push to `main` (or run the Deploy workflow manually) →
1. **Build**: both images build → GHCR, tagged `:latest` and `:${{ github.sha }}`.
2. **Migrate**: a `migrate` job checks out the repo, `npm ci`, then `npm run db:migrate` against
   `DATABASE_URL_MIGRATE` — **fails closed**: if the secret is unset, the job exits non-zero before
   running anything, and `deploy` never starts (it depends on `migrate` succeeding).
3. **Deploy**: scp `deploy/docker-compose.yml` to the box (every deploy — the box never keeps a stale compose file), SSH: upsert `IMAGE_TAG=<sha>` into `.env`, `docker compose pull && docker compose up -d --wait --wait-timeout 180` (the healthchecks gate the image prune), then curl `https://recharacter.us/login` until it returns 200.

`docker-compose.yml` pins both app images to `${IMAGE_TAG:-latest}`, so every deploy runs an
immutable, known SHA rather than whatever `:latest` happened to resolve to at pull time. Both
`web` and `routing` carry healthchecks (`GET /api/health` via `wget`, `GET /healthz` over raw
`/dev/tcp` respectively — neither base image ships curl); `web` waits on `routing`'s healthcheck
before compose brings it up. Zero-downtime-ish (containers restart in seconds; cloudflared
reconnects).

**Rollback:** SSH to the box and run `IMAGE_TAG=<sha> docker compose up -d` with the SHA of the
last-known-good deploy (find it in the Deploy workflow run history or `git log`). A rollback does
**not** revert schema migrations — qavren-db migrations are additive/forward-only by convention,
same as the rest of the fleet.

## Cutover runbook (Steve; app secrets never enter git)

**One-shot version:** `deploy/cutover.ps1` does steps 2–5 below in one run over SSM (the
same transport as qavren-auth's `infra/update-realms.ps1`): rotates the prod role, reads
the admin-client secret off the auth box, rewrites the box `.env` (previous file kept as
`.env.pre-qavren-<stamp>`), sets `DATABASE_URL_MIGRATE`, dispatches Deploy and smokes
`/login`. Only step 1 (the R2 bucket + token) is a dashboard step.

```powershell
pwsh deploy/cutover.ps1 -R2AccessKeyId <id>          # preflight + plan, changes nothing
pwsh deploy/cutover.ps1 -R2AccessKeyId <id> -Apply   # the cutover; prompts for the R2 secret
```

Manual equivalent:

1. R2: create bucket `recharacter-case-documents` (private), an R2 API token scoped to it (Object Read & Write) → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
2. qavren-db: `cd C:\Users\steve\projects\qavren-db; pwsh tools/provision-app.ps1 -App recharacter -Env prod -RotatePassword` → build `DATABASE_URL` (`…pooler.supabase.com:6543`) and `DATABASE_URL_MIGRATE` (`:5432`) → `gh secret set DATABASE_URL_MIGRATE -R stevenfackley/recharacter`; put `DATABASE_URL` in the box `.env`.
3. qavren-auth: confirm the auth box holds `RECHARACTER_ADMIN_CLIENT_SECRET` (compose.prod.yaml refuses to start without it); copy the same value to the box `.env` as `QAVREN_ADMIN_CLIENT_SECRET`.
4. Box `.env`: add `AUTH_SECRET=$(openssl rand -base64 32)`, `AUTH_URL=https://recharacter.us`, `QAVREN_AUTH_URL=https://auth.recharacter.us`, the four `R2_*`, `DATABASE_URL`; remove `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
5. Merge the PR → Deploy runs `migrate` (fails closed if step 2 was skipped) → pulls SHA-tagged images.
6. Smoke as below. Old Supabase project `ldxgdceplsdycviroisd`: pause now, delete after 7 days (playbook §6).

## Post-deploy smoke checklist

- `https://recharacter.us` renders the landing page (Cloudflare TLS).
- Register a new account on Keycloak's hosted page (`/login` → registration link, or `prompt=create`
  deep link from the signup page) → redirected back signed in.
- Manual facts → routing renders (proves web→routing on the compose network).
- Upload a DD-214 → extraction (proves web→R2 and web→Anthropic with the prod key).
- `/settings/ai` BYOK save → packet page shows "Case unlocked" (proves KEK + entitlement).
- Delete the test account from `/settings/data` → confirm the user is gone from the Keycloak
  `recharacter` realm (proves the admin-svc deletion path, not just the app-side redirect).

## Deliberately not in this stack (tracked in docs/launch-checklist.md)

Stripe live mode · error tracking (Sentry) · uptime checks · custom SMTP (Keycloak's own realm
mail config, a qavren-auth concern, not this repo's) · rate limiting beyond Cloudflare defaults ·
backups beyond qavren-db's own (nightly per-schema dump → R2, platform-managed).
