# Decisions

## 2026-08-19 — Dependabot sweep: majors merged

**Status:** accepted (awareness-only stub per saved sweep policy)
**Decision:** merged on green CI (standing recharacter merge authorization).
- **xunit.runner.visualstudio 3.1.5 → 4.0.0** (#60): silent zero-discovery is the failure mode — confirm CI still reports non-zero "Passed:" counts.
- **typescript 5.9.3 → 6.0.3** (/web, #49): TS 6 drops several legacy compiler flags and tightens narrowing; typecheck passed in CI, so /web is clean at current strictness.
- **jsdom 29 → 30** (#47) and **coverlet.collector 6 → 10** (#50) follow after rebase — dev/test-only surface.

**Why no review:** sweep policy — CI gates, deploy watch, revert cheap.
