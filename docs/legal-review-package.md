# Attorney-Review Package

**Purpose:** the complete inventory of everything a licensed attorney must review before ReCharacter launches publicly. This consolidates every item flagged "attorney-review surface" across the codebase. Review sign-off on this package is a **hard launch gate** (see `docs/legal-posture.md`).

**How to use:** each item lists what it is, where it lives (file:symbol), and the specific question(s) to answer. The posture standard throughout: *document assembly + information, never legal advice; the veteran decides and files.*

---

## 1. AI system prompts (the model's standing instructions)

All six live in `web/src/lib/ai/tasks.ts` (each task's `system` string). The gateway makes these the ONLY ways the model can be invoked.

| Task | What it does | Review questions |
|---|---|---|
| `ping` | connectivity check | none — trivial |
| `extract_service_facts` | reads a DD-214/photo → nullable structured facts; forbidden to guess | Does "report ONLY what it states / never guess" plus nullable-everything suffice? |
| `coaching_note` | renders the deterministic score/gap into 2–3 encouraging sentences | Forbids outcome prediction, legal advice/strategy, lawyer mentions, deadlines — tight enough? |
| `shape_nexus_answer` | restructures the veteran's OWN narrative for one Kurta question | "never add facts…"; gaps hints limited to "about their experience only, never about what would persuade the board" — is the gaps concept itself acceptable? |
| `draft_statement` | assembles the personal statement from the four approved answers | The one permitted legal reference is the liberal-consideration request — correctly scoped? |
| `draft_cover_letter` | one-page formal cover letter | Same liberal-consideration carve-out; bracketed placeholders for identity fields |

**Structural guarantees to verify against the code (not just the prompts):** no free-form AI endpoint exists (`web/src/lib/ai/tasks.ts` registry + `web/src/app/api/ai/[task]/route.ts` 404s unknown tasks); AI output never persists without a human action (`resolveConfirmed` in `web/src/lib/facts.ts`; proposal flow in `web/src/app/case/nexus/question.tsx`; `regenerateAllowedFor` in `web/src/lib/drafts.ts`).

## 2. The Kurta interview copy

`web/src/lib/nexus.ts` → `KURTA_QUESTIONS` — four plain-language prompts + explainers paraphrasing the Kurta memo's four questions. **Questions:** are the paraphrases faithful to the memo? Does any explainer cross from process education into individualized advice? (Q4 wording: spec quotes the memo's "outweigh the discharge.")

## 3. The evidence rubric

`web/src/lib/evidence.ts` → `EVIDENCE_CATALOG` (weights + guidance strings) and `docs/domain/evidence-rubric.md` (mirror + formula + bands + disclaimer header). **Questions:** are the relative weights defensible as *completeness* guidance? Is the MST own-testimony note (Kurta basis) stated correctly? Is the "not a prediction of board outcomes" disclaimer adequate and prominent enough in the UI (`/case/evidence` page copy)?

## 4. Routing display copy

`web/src/app/case/page.tsx` → `FLAG_TEXT` — plain-English translations of the engine's advisory flags (15-year window, GCM→BCMR, Coast Guard/DHS, 3-year-waiver-likely, uncharacterized, already-honorable) plus the "computed filing route… process information, not legal advice" line. **Questions:** each sentence's legal accuracy; is "routinely waived in the interest of justice" acceptable phrasing for the §1552 waiver practice?

## 5. Packet contents (Plan 07)

`web/src/lib/packet/worksheet.ts` (item-number → value literals for DD-293 and DD-149) and `web/src/lib/packet/sections.ts` (How-to-File page copy incl. the verbatim line *"This packet is document assembly, not legal advice. You decide what to file, and you file it yourself."*). **Questions:** do the worksheet item mappings match the CURRENT form revisions (DD-293 DEC 2019; DD-149 JAN 2023 — re-verify revisions at review time); is "SEE ATTACHED STATEMENT" appropriate for the long-form items; filing-instruction accuracy.

## 6. Domain primer citations

`docs/domain/discharge-upgrades.md`. **Verify:** 10 U.S.C. §1552/§1553 characterizations; DoDI 1332.28; Hagel (2014-09-03), Kurta (2017-08-25), **Wilkie — the doc flags its date needs confirmation (commonly grouped with 2017 guidance; issued 2018-07-25)**; DRB 15-year inclusive-deadline reading; the special-vs-general court-martial DRB eligibility line; the "upgrade petition ≠ VA benefits claim" framing.

## 7. Disclaimers & positioning copy

- `docs/legal-posture.md` — the boundary document itself (DOES/DOES NOT lists).
- In-app: intake privacy line ("Stored privately; only you can access it"), evidence-page disclaimer, draft-page banner ("These are drafts you own… Nothing is filed until you file it"), packet How-to-File page, upgrade-page freemium copy (Plan 08).
- **Not yet written:** marketing-site copy, in-app footer disclaimer, packet cover-page disclaimer, Terms of Service, Privacy Policy. These need drafting + review before launch.

## 8. Business-model questions for counsel

- Charging for AI-assisted document assembly (flat unlock) — any UPL interaction with taking payment for drafting? (Posture: fee is for software, veteran owns/edits/files.)
- The BYOK-equals-entitlement rule (user's own API key, their provider relationship).
- Data handling disclosures: mental-health narratives to the AI provider on the managed tier (API traffic not used for training by default) vs. the user's own account on BYOK; retention + delete commitments (`docs/legal-posture.md` §Data sensitivity — one-click delete/export is still a TODO in code).

## 9. Sign-off checklist

- [ ] All six system prompts approved (or amended — they live in one file)
- [ ] Kurta question copy approved
- [ ] Evidence rubric + weights approved
- [ ] Routing flag copy approved
- [ ] Worksheet mappings verified against current form revisions
- [ ] Domain primer citations verified (incl. Wilkie date)
- [ ] Disclaimer set approved; ToS/Privacy Policy drafted & approved
- [ ] Business-model questions (§8) answered
- [ ] Live product walkthrough performed by the reviewer (needs `ANTHROPIC_API_KEY` + routing service)
