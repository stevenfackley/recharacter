# Production deployment — recharacter.us

Architecture: **Qavren-Web-Server (existing EC2, rootless Docker)** runs `deploy/docker-compose.yml`
(web + routing + cloudflared). Ingress is a **Cloudflare Tunnel** — no inbound ports on the box,
TLS at Cloudflare (which is also the domain registrar). Database/auth/storage is a **cloud Supabase
project** (`recharacter`, us-east-1, Steve's Database Org). Images live in **GHCR**, built and
deployed by `.github/workflows/deploy.yml` on every push to `main`.

```
Internet ──TLS──> Cloudflare (DNS+proxy) ──tunnel──> cloudflared ──> web:3000 ──> routing:8080
                                                                    │
                                                                    └──HTTPS──> Supabase cloud / Anthropic API
```

## One-time setup

### 1. Supabase (blocked on billing as of 2026-07-06 — settle org invoices first)
1. Settle overdue invoices: supabase.com → Steve's Database Org → Billing.
2. Project creation, all 7 migrations, and auth config (Site URL `https://recharacter.us`,
   redirect URLs) are then done by Claude via the Supabase MCP — say the word.
3. Copy Project URL + anon key into the box `.env`.

### 2. Cloudflare Tunnel (dashboard)
1. Cloudflare Zero Trust → Networks → Tunnels → **Create a tunnel** (name: `recharacter`).
2. Copy the **tunnel token** into the box `.env` as `TUNNEL_TOKEN`.
3. Public hostname: `recharacter.us` → service `HTTP://web:3000` (add `www` too if wanted —
   the tunnel auto-creates the DNS records since Cloudflare is the registrar).

### 3. The box (Qavren-Web-Server, rootless docker)
Known quirks (from Qavren ops): rootless docker needs `loginctl enable-linger $USER` or pulls
die after logout; reach the box via `Qavren.pem` + public DNS (not Tailscale).

```bash
mkdir -p ~/recharacter && cd ~/recharacter
# GHCR is private: one-time login with a PAT that has read:packages
docker login ghcr.io -u stevenfackley
# Fetch the compose file (or scp it):
curl -fsSL https://raw.githubusercontent.com/stevenfackley/recharacter/main/deploy/docker-compose.yml -o docker-compose.yml
# ^ private repo: use `gh api` or scp instead if curl 404s.
cp env.example .env   # then fill every value (see deploy/env.example)
docker compose up -d
```

`.env` values: Supabase URL + anon key (step 1), `ANTHROPIC_API_KEY`, a freshly generated
`AI_KEY_ENCRYPTION_SECRET` (`openssl rand -base64 32` — losing it just means BYOK users re-enter
keys), `APP_BASE_URL=https://recharacter.us`, `TUNNEL_TOKEN` (step 2).

### 4. GitHub secrets (repo → Settings → Secrets → Actions)
| Secret | Value |
|---|---|
| `DEPLOY_HOST` | Qavren-Web-Server public DNS |
| `DEPLOY_USER` | the rootless-docker user on the box |
| `DEPLOY_SSH_KEY` | contents of `Qavren.pem` |

## Every deploy after that

Push to `main` (or run the Deploy workflow manually) → both images build → GHCR → SSH pull +
`docker compose up -d`. Zero-downtime-ish (containers restart in seconds; cloudflared reconnects).

## Post-deploy smoke checklist
- `https://recharacter.us` renders the landing page (Cloudflare TLS).
- Sign up with a real email → confirm auth emails arrive (Supabase default SMTP at first;
  custom SMTP is a follow-up).
- Manual facts → routing renders (proves web→routing on the compose network).
- Upload a DD-214 → extraction (proves web→Anthropic with the prod key).
- `/settings/ai` BYOK save → packet page shows "Case unlocked" (proves KEK + entitlement).

## Deliberately not in this stack (tracked in docs/launch-checklist.md)
Stripe live mode · error tracking (Sentry) · uptime checks · custom SMTP · rate limiting beyond
Cloudflare defaults · backups beyond Supabase's own.
