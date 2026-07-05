# ReCharacter — Design Spec v0.1

- **Date:** 2026-07-05
- **Status:** Approved in brainstorm; pending user review of this written spec
- **Sibling product:** Reclaim (health-insurance appeals). Same *shape* (self-help document-assembly appeal tool), independent codebase. No shared code (rule of three — revisit at product #3).

---

## 1. Summary

ReCharacter is a self-help web app that helps a U.S. veteran with a less-than-honorable discharge build and file a **mental-health-based discharge-upgrade petition** under the military's "liberal consideration" policy. It ingests the veteran's story and records, routes them to the correct review board and form, interviews them to construct a nexus argument, drafts the supporting statement, coaches them on gaps, and exports a **ready-to-file packet the veteran owns and submits themselves**.

**Founding case (dogfood target):** Marine Corps, ~2 years served, **OTH administrative separation**, precipitated by conduct linked to an **adjustment disorder** arising from abuse and threats that went unbelieved — a textbook liberal-consideration fact pattern.

## 2. Legal framing & posture

### Liberal consideration (the product thesis)
Discharge upgrades for mental-health-related misconduct are governed by DoD-wide policy — the **Hagel (2014)**, **Kurta (2017)**, and **Wilkie (2017)** memos — which *direct* review boards to give favorable weight to petitions where a mental-health condition (or MST) has a **nexus** to the misconduct behind the discharge. This doctrine is **federal and uniform across all branches**, which is why the MVP can cover every branch while curating only one legal theory.

### The Kurta four questions (product core IP)
The Kurta memo requires boards to weigh four things for a mental-health upgrade. Every strong petition is an evidenced answer to these:
1. Did the veteran have a condition or experience that may excuse or mitigate the discharge?
2. Did that condition exist / experience occur during military service?
3. Does that condition or experience actually excuse or mitigate the discharge?
4. Does that condition or experience outweigh the misconduct?

The AI's job is to interview the veteran to fill these four board-defined slots and render them as prose — **not** to give open-ended legal advice.

### Self-help / UPL posture (non-negotiable, inherited from Reclaim)
- The app performs **document assembly + information**, never legal advice.
- Output is a **draft the veteran owns and files**. The app never represents the veteran before a board.
- **Hard gate before launch:** licensed-attorney sign-off on all disclaimer/positioning copy.

## 3. Scope

### In (MVP)
- All five DoD branches (Army, Navy, Marine Corps, Air Force, Space Force).
- **Mental-health / liberal-consideration theory only** (incl. MST as a mental-health basis).
- Deterministic routing to the correct board + form + filing window.
- AI-assisted intake, nexus construction, statement drafting, and case-strength coaching.
- Packet export (filled DD form + statement + cover + evidence index + buddy-statement templates).

### Out (explicitly deferred)
- Coast Guard (DHS, analogous-but-not-identical policy) — ships **last**, after DoD branches.
- Other upgrade theories: clemency, propriety/equity, plain factual/legal error.
- Filing on the veteran's behalf (accreditation risk — see Risks).
- Assisted certified mail (Lob) — post-MVP convenience.
- Local/self-hosted inference (right for Reclaim's PHI constraint; wrong here, where drafting quality decides cases).

## 4. Core user flow

```
Intake  →  Routing  →  Evidence  →  Nexus Builder  →  Draft  →  Coaching  →  Packet
(story)   (rules)    (checklist)   (Kurta 4 Qs)      (AI)     (gaps/odds)  (export)
```

1. **Intake** — conversational; the veteran tells their story. AI extracts structured facts (branch, discharge date & type, condition, stressors, MST flag, timeline). Uploaded records (DD-214, service/medical records — as PDFs or phone photos) are read directly by the cloud model.
2. **Routing** — *deterministic, not AI.* branch + discharge date + type → board (DRB if ≤15 yr, else BCMR) + correct form (DD-293 vs DD-149) + filing deadline. This is the .NET rules engine.
3. **Evidence** — generates a personalized checklist and tracks collection status: DD-214, service treatment records, **VA disability rating** (strong corroboration), civilian mental-health records, **buddy/witness statements** (directly counters "no one believed me"), and a **clinician nexus letter**.
4. **Nexus Builder** — the Kurta 4-question interview; each answer is a structured, evidence-linked slot.
5. **Draft** — AI drafts the personal statement + cover letter from the structured nexus, quoting the veteran's own words.
6. **Coaching / Case Strength** — scores the case against liberal-consideration factors, surfaces the single highest-leverage gap (e.g., "no nexus letter — your biggest missing piece"), and suggests concrete strengtheners. This is the "tips to increase approval odds" feature.
7. **Packet** — fills the official DD form, assembles statement + evidence index + cover, exports a PDF the veteran files (board online portal or mail).

## 5. AI architecture

- **Hybrid delivery:**
  - **Managed proxy tier (default):** app holds provider keys, meters tokens, bills via Stripe. Frictionless for non-technical veterans.
  - **BYOK passthrough:** veteran pastes their own API key; requests go to their own provider account, bypassing app billing. Best privacy/cost control for power users.
- **Model:** frontier cloud model (Claude) for both **document extraction** and **drafting** — no Python sidecar; the model reads uploaded PDFs/photos natively.
- **Bounded tasks only (anti-UPL):** every AI call is scoped — extract facts, fill a specific Kurta slot, draft from structured input, score against fixed factors. Never open-ended "what should I do."

## 6. Tech stack & components

| Component | Choice | Rationale |
|---|---|---|
| Rules API | **.NET** (port Reclaim's engine discipline: pure functions, injected clock, heavy xUnit) | Board/form/deadline routing is the one place a bug = a missed filing deadline. Deterministic + tested hard. |
| Web | **Next.js** (TypeScript) | Wizard flow + packet preview. Hosts server routes for AI proxy + BYOK. |
| Data / Auth / Files | **Supabase** — Postgres + **RLS**, Auth, Storage | RLS ensures a veteran sees only their own records; encrypted document storage; one vendor. |
| AI | **Claude** via Next.js server routes | Managed proxy + BYOK; native PDF/vision extraction. |
| PDF | **pdf-lib** | Fill official DD-293 / DD-149. |
| Billing | **Stripe** | Managed-tier metering / subscription. |

## 7. Data model (sketch)

- **Veteran/User** — auth identity.
- **Case** — one upgrade effort; owns everything below; RLS-scoped to the user.
- **ServiceFacts** — branch, discharge date, discharge type/characterization, MST flag.
- **Condition** / **TimelineEvent** — the mental-health condition + dated stressors/incidents.
- **EvidenceItem** — type, storage reference, collection status, strength weight.
- **NexusAnswers** — the four Kurta slots, each linked to supporting EvidenceItems.
- **Draft** — personal statement + cover letter versions.
- **Routing** — computed board + form + deadline (from the rules engine).
- **PacketExport** — assembled PDF reference.
- **AiCredential** — encrypted BYOK key (nullable; null = managed tier).
- **Usage/Subscription** — token metering + Stripe state.

## 8. Data & privacy

Mental-health records and trauma narratives are the most sensitive data class. Controls:
- RLS on every table; encrypted document storage.
- Explicit retention policy + one-click delete/export.
- Plain-English disclosure: managed tier sends text to the AI provider (whose API does not train on it by default); BYOK data goes only to the veteran's own provider account.
- Managed proxy makes the app a **data processor** for this content — retention, breach, and disclosure obligations must be owned explicitly (see Risks).

## 9. Branch routing table

| Branch | DRB (≤15 yr, DD-293) | BCMR (>15 yr / corrections, DD-149) |
|--------|----------------------|--------------------------------------|
| Army | ADRB | ABCMR |
| Navy / Marine Corps | NDRB | BCNR |
| Air Force / Space Force | AFDRB | AFBCMR |
| Coast Guard *(ships last)* | CGDRB | BCMR (DHS) |

## 10. Business model

**Freemium.** Free: intake, eligibility, routing, evidence checklist, and education. Paid (managed-proxy tier or BYOK): AI drafting + packet assembly. A veteran with no money still reaches a complete personalized action plan at \$0 and only pays at the highest-value step. Pricing kept intentionally low given the audience.

## 11. Risks & deferred items

- **Attorney sign-off (hard launch gate):** disclaimer + positioning copy must be reviewed by a licensed attorney before any public launch.
- **Deadline-calc correctness:** the DRB 15-year boundary and BCMR windows must be tested exhaustively; a wrong deadline is the worst possible bug.
- **Accreditation line:** packet-only keeps the app out of "representation," which can require VSO/attorney accreditation. Do not cross into filing-on-behalf without legal review.
- **Managed proxy = data-processor duties:** billing, abuse controls, key custody, retention, and breach obligations for sensitive records all land on the operator.
- **Coast Guard asterisk:** DHS, not DoD; liberal-consideration policy is analogous, not identical — ship last, verify separately.
- **Domain / trademark:** confirm availability for "ReCharacter" (mirrors Reclaim's naming caveat).

## 12. Open questions (for later plans)

- Exact case-strength scoring rubric (which factors, what weights).
- Buddy-statement + nexus-letter template content (needs review).
- Managed-tier pricing shape (metered vs flat-per-case within the paid step).
- Whether intake is a scripted wizard or a freer AI conversation for step 1.
