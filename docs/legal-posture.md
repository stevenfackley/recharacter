# Legal posture: self-help, never advice

This document defines the boundary ReCharacter must never cross, and how the code enforces it. It exists because the product's usefulness and its greatest legal risk are the same thing: helping people with a legal process without practicing law (UPL — unauthorized practice of law).

## The posture

ReCharacter is a **document-assembly and information tool**. The veteran makes every decision; the app organizes, explains, drafts from the veteran's own words, and assembles. The output is a packet **the veteran owns and files themselves**.

### The app DOES
- Explain the process in plain language (boards, forms, deadlines, evidence types) — published, general information.
- Compute deterministic routing (board/form/deadline) from facts the veteran provides.
- Interview the veteran to organize *their* story into the Kurta framework, quoting their own words.
- Draft documents *from that structured input* for the veteran to review, edit, and own.
- Score completeness against the published liberal-consideration factors and point at gaps.

### The app does NOT
- Represent the veteran before any board, or file anything on their behalf (accreditation territory — VSO/attorney).
- Advise whether to file, predict outcomes, or recommend legal strategy for an individual's situation.
- Offer any free-form "ask a legal question" surface.
- Hold itself out as a lawyer, law firm, or accredited representative.

## How the code enforces it

1. **No free-form AI endpoint.** Every AI call goes through `POST /api/ai/[task]` against a closed **task registry** — fixed system prompt, validated input, JSON-schema-constrained output. "What should I do about my case?" has no route to reach the model.
2. **Deterministic routing is code, not AI.** Board/form/deadline come from the tested .NET rules engine, presented as computed facts with statutory anchors — not model opinions.
3. **Drafts quote the veteran.** Drafting tasks are constructed from the veteran's structured answers; prompts instruct the model to preserve the veteran's own words, and outputs are presented as *drafts for the veteran's review and editing*.
4. **Packet-only delivery.** The final artifact is a download the veteran files. No submission conduit exists in the MVP by design.

## Hard gates before public launch

- [ ] **Licensed-attorney review** of all disclaimer and positioning copy (marketing site, in-app footer, packet cover page). This is a launch blocker, not a nice-to-have.
- [ ] Attorney confirmation of the DoDI/statute/memo citations in `docs/domain/discharge-upgrades.md` (incl. the Wilkie memo's exact date/citation).
- [ ] Review of the drafting prompts + a sample of generated statements for anything that reads as individualized legal advice.
- [ ] Plain-English data disclosure: managed tier sends text to the AI provider (API traffic not used for training by default); BYOK traffic goes to the user's own provider account.

## Data sensitivity

Petitions contain mental-health histories and trauma narratives — the most sensitive data class this workspace handles. Commitments: RLS on every table (isolation proven by tests), encrypted document storage, encrypted BYOK keys (AES-256-GCM, no plaintext at rest), explicit retention + one-click delete/export (Plan 04+), no AI training on user content.

## Precedent worth remembering

The cautionary tale is DoNotPay (FTC settlement, 2024) — an AI "legal" product that marketed lawyer-equivalent advice without the substance behind it. ReCharacter's design inverts that: narrow, bounded, document-assembly tasks; deterministic legal-process facts; human ownership of every decision and filing. When in doubt, the answer is *less* scope for the model, not more disclaimer text around a too-broad feature.
