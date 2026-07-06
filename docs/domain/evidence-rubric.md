# Evidence rubric (attorney-review surface)

> **This rubric is product guidance about evidence completeness, not a prediction of board outcomes. Attorney review required before launch; changes to weights are reviewed edits.**

The checklist personalization and case-strength score in `web/src/lib/evidence.ts` are pure, deterministic functions over the data documented here — there is no AI in this path. This document is the reviewable source of truth for that data; a code change to `EVIDENCE_CATALOG` should always be accompanied by an update here.

## The seven evidence items

Weight is relative, not absolute — only the ordering and proportion between items matters (the score always normalizes over whichever items are applicable to a given case).

| Item | Weight | Rationale |
|------|-------:|-----------|
| Nexus letter from a mental-health clinician | 30 | The single most persuasive document a petition can include — a licensed clinician's professional opinion directly connecting the in-service condition to the conduct behind the discharge. |
| VA disability rating letter | 20 | Strong third-party corroboration that the condition exists and is already service-connected in a separate federal adjudication. |
| Service treatment / in-service mental-health records | 15 | Contemporaneous records showing the condition, or the events around it, actually occurred during service. |
| Buddy / witness statements | 15 | Corroborate events or a change in the veteran observed by others — especially important when the in-service events were unreported or disbelieved at the time. |
| Civilian mental-health records | 10 | Diagnosis or treatment records from before or after service; show the trajectory of the condition. |
| Your personal statement | 10 | The veteran's own narrative, structured around the four Kurta questions. Always available, but the least corroborated evidence on its own. |
| DD-214 (Certificate of Release or Discharge) | 5 | The baseline document every petition needs; usually already on file from intake. |

## Personalization rules

Every case gets the four **universal items**: `dd214`, `personal_statement`, `buddy_statement`, `nexus_letter`. Three additional items are recommended only when the veteran's context answers make them applicable:

| Context answer | Adds item |
|---|---|
| Treated in service for the condition | `service_treatment_records` |
| Has an existing VA disability rating | `va_rating_letter` |
| Condition category is anything other than "unsure" | `civilian_mh_records` |

**MST own-testimony note (Kurta basis):** when the veteran indicates their case involves military sexual trauma, the guidance on `personal_statement` is extended to note that review boards are directed (per the Kurta memo's MST guidance) to accept the veteran's own statement as evidence that the experience occurred — the absence of a contemporaneous report does not, by itself, sink a case. See `docs/domain/discharge-upgrades.md` for the underlying Kurta memo summary.

## Score formula

```
score = round(100 * collected_weight / applicable_weight)
```

- `applicable_weight` sums the weight of every recommended item whose status is **not** `not_applicable`.
- `collected_weight` sums the weight of every applicable item whose status is `collected`.
- Items marked `not_applicable` are excluded from both the numerator and the denominator — they do not penalize the score.
- If there are no applicable items, the score is `0`.

The **top gap** is the highest-weight applicable item that is not yet `collected` — the single highest-leverage next step named back to the veteran. When every applicable item is collected, there is no top gap.

## Bands

| Score | Band |
|-------|------|
| < 40 | building |
| 40–74 | developing |
| ≥ 75 | strong |

## Buddy statements and document linking (MVP scope)

Buddy statements count once toward the score at MVP regardless of how many individual statements the veteran collects — no per-statement stacking. Evidence status is self-reported; linking specific uploaded documents to a checklist item is deferred to a later plan (the storage bucket from the intake flow already exists and can support this later).
