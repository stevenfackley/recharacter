# web/

The Next.js 16 app: wizard UI, Auth.js + Keycloak sign-in, owner-scoped Drizzle data modules, the bounded AI gateway, packet assembly and billing.

Everything you need is in the repo docs — start with [`../docs/development.md`](../docs/development.md) (local stack, commands, gotchas) and [`../docs/architecture.md`](../docs/architecture.md) (the owner-scoping invariant that replaces RLS, the identity flow, the env contract).

```bash
docker compose -f ../compose.dev.yaml up -d   # Postgres 17 (:55433) + MinIO (:9100)
cp .env.example .env.local                     # then set AUTH_SECRET etc.
npm ci && npm run db:migrate && npm run dev
npx vitest run src        # unit
npx vitest run tests      # integration (needs the stack)
```
