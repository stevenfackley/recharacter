# Draft-quality evaluation — 2026-07-11

Launch-checklist §1: "generate statements from several synthetic fact patterns (each branch, MST case, GCM case) and read them against the prompts' rules (no invented facts, no advice)."

## Method

- Prompts imported directly from `web/src/lib/ai/tasks.ts` (no copies — the eval exercised exactly what production runs), called with the gateway's own parameters (claude-opus-4-8, adaptive thinking, JSON-schema-constrained output).
- 5 personal-statement fact patterns + 2 cover letters, each with four Kurta answers written in a distinct veteran voice with deliberately checkable specifics (names, dates, diagnoses).
- Every output audited by a separate adversarial judge call (same model, independent system prompt) for: invented facts, advice/strategy/outcome language, voice preservation, required structural elements. Human spot-check on top.

## Cases and verdicts

| Case | Pattern | Verdict |
|---|---|---|
| 01 | Army / OTH 2011 / combat PTSD (Kandahar, IED, AWOL) | pass |
| 02 | Navy / GEN 2016 / MST, unreported, UA to avoid assailant | pass |
| 03 | USMC / OTH 2018 / adjustment disorder, hazing, one positive urinalysis | pass |
| 04 | Air Force / BCD 2009 via GCM / undiagnosed bipolar I (BCMR-only routing) | pass |
| 05 | Space Force / OTH 2023 / in-service depression, **no evidence collected** | **fail** |
| 02-cover | NDRB / DD-293 | pass |
| 04-cover | AFBCMR / DD-149 | pass |

Consistent strengths across all cases: veterans' words preserved nearly verbatim (e.g. case 05's closing "The mission never lost anything from me that the depression did not take first" kept untouched), correct opening (service + characterization petitioned), four answers in original order, closing limited to the liberal-consideration request, zero advice/strategy/outcome language, cover letters produced correct bracketed placeholders and enclosure lines.

## The one failure and its fix

With `collectedEvidence: []`, `buildPrompt`'s fallback wording `"Evidence being included: listed separately"` induced the model to write **"I have included evidence with this petition"** — a false factual claim for a veteran who has collected nothing, in a document bound for a federal board.

Fix (PR #21): fallback wording → `"none yet"`, plus an explicit system-prompt rule — never say evidence is included/enclosed/attached unless the evidence list names at least one item — pinned by a unit test. Re-ran the failing fact pattern against the tuned prompt: judge verdict **pass**, zero invented facts, voice still preserved.

## Also verified in passing

- The 40-char `boardName` input cap on `draft_cover_letter` is safe: the app passes board abbreviations from the rules engine's `BoardDirectory` (NDRB, AFBCMR, …), never full board names.
- Coast Guard was deliberately excluded (rollout deferred pending DHS policy verification — see checklist §7).
