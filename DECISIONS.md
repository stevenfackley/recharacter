# Decisions

## 2026-08-19 — Dependabot sweep: majors merged

**Status:** accepted (awareness-only stub per saved sweep policy)
**Decision:** merged on green CI (standing recharacter merge authorization).
- **xunit.runner.visualstudio 3.1.5 → 4.0.0** (#60): silent zero-discovery is the failure mode — confirm CI still reports non-zero "Passed:" counts.
- **typescript 5.9.3 → 6.0.3** (/web, #49): TS 6 drops several legacy compiler flags and tightens narrowing; typecheck passed in CI, so /web is clean at current strictness.
- **jsdom 29 → 30** (#47) and **coverlet.collector 6 → 10** (#50) follow after rebase — dev/test-only surface.

**Why no review:** sweep policy — CI gates, deploy watch, revert cheap.

## 2026-09-22 — Dependabot sweep: vitest 5 merged

**Status:** accepted (awareness-only stub per saved sweep policy)
**Decision:** merged on green CI (standing recharacter merge authorization).
- **vitest 4.1.11 → 5.0.1** (/web, #79): no config change needed; CI ran the full suite on 5.0.1 (55 test files integration lane, 44 unit) plus e2e, all green.
- Watch for: Vite-major config moves (`ssr.resolve.conditions`) if `@vitejs/plugin-react` or vite itself majors next.

**Why no review:** sweep policy — CI gates, deploy watch, revert cheap.
