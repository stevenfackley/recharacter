# Packet Assembly & Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click produces the veteran's complete, filing-ready packet PDF — cover letter, personal statement, evidence index, and a form worksheet that maps every answer to the official DD-293/DD-149 item numbers — plus clear guidance for completing and signing the official form itself.

**Architecture (reshaped by the DD-form scout — read this):** The official DD-293 (DEC 2019) and DD-149 (JAN 2023) are **hybrid XFA/LiveCycle PDFs that pdf-lib cannot load at all** (fatal parse error before `getForm()` is reachable), and programmatic filling of the XFA layer isn't viable in pure JS. The forms ARE interactively fillable by the veteran in Acrobat/browser — and require the veteran's own signature regardless. So the packet does NOT embed or fill the official form. Instead it generates a **form worksheet**: item-by-item values keyed to the official form's item numbers ("Item 4: Branch — Marine Corps"), so transcription takes minutes and nothing depends on the form's internal structure or revision layout. Coordinate-overlay filling is explicitly deferred (documented risks: coordinate drift across DoD revisions, background flattening for DD-149). The packet PDF itself is built with pdf-lib's text/layout API (which it handles fine) from **pure, unit-testable section builders**; generation is on-demand (no new tables, no storage) via a download route handler.

**Tech Stack:** existing stack + `pdf-lib` (already a planned dependency; layout use only).

**Depends on:** Plan 06 merged (drafts, nexus answers, evidence, routing).

**Stated assumptions (veto on review):**
- The packet contains: (1) cover letter, (2) personal statement, (3) evidence index, (4) form worksheet, (5) a final "how to file" page (get the official form from esd.whs.mil, fill per worksheet, sign, attach this packet's statement + evidence). We do NOT redistribute the official form bytes.
- Generation gates: confirmed facts + reachable routing + a personal-statement draft. Cover-letter draft and evidence items are included when present (evidence index renders "none listed yet" otherwise; a missing cover-letter draft falls back to the worksheet-only guidance page — the statement is the hard requirement).
- We never collected name/SSN/address: worksheet rows for those render bracketed placeholders (`[Your full legal name]`) — consistent with the cover-letter task's placeholder convention.
- The characterization REQUESTED (vs. current) has never been asked anywhere: the worksheet renders `[The characterization you are requesting — most mental-health petitions request Honorable or General (Under Honorable Conditions)]`. Adding a real "requested characterization" field to intake is deliberately out of scope (would touch Plan 04 surfaces); tracked in Notes.
- Long-form answers (statement) are attached, not transcribed: the worksheet instructs "Item 6 (issues): write 'SEE ATTACHED STATEMENT'" — standard practice for these forms.

---

## File structure

```
web/src/lib/packet/sections.ts        # PURE builders: each section → PacketSection (lines/blocks)
web/src/lib/packet/render.ts          # pdf-lib: PacketSection[] → Uint8Array (wrapping, pagination)
web/src/lib/packet/worksheet.ts       # PURE: facts/routing/answers → item-number rows per form
web/src/lib/packet/sections.test.ts
web/src/lib/packet/worksheet.test.ts
web/src/lib/packet/render.test.ts     # smoke: loads output back with pdf-lib, page count, metadata
web/src/app/case/packet/route-helpers.ts? (no — keep logic in the route)
web/src/app/api/packet/route.ts       # GET → application/pdf download (auth + gates)
web/src/app/case/packet/page.tsx      # readiness checklist + download + official-form guidance
web/src/app/case/page.tsx             # step 6 wiring
```

Install (from `web/`): `npm install pdf-lib`

## Data shapes (shared by tasks below — define in `sections.ts`)

```ts
export type PacketLine =
  | { kind: 'heading'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'body'; text: string }
  | { kind: 'item'; label: string; value: string }
  | { kind: 'spacer' }

export type PacketSection = { title: string; startOnNewPage: boolean; lines: PacketLine[] }

export type PacketInput = {
  generatedOn: string // ISO date, injected (no Date.now inside builders)
  facts: { branch: string; dischargeDate: string; characterization: string; wasGeneralCourtMartial: boolean }
  routing: { boardName: string; recommendedForm: 'DD293' | 'DD149'; drbDeadline: string; drbWindowOpen: boolean }
  statement: string
  coverLetter: string | null
  evidence: Array<{ label: string; status: string }>
}
```

---

## Task 0: Worksheet builder (pure) — the form-item mapping

**Files:** Create `web/src/lib/packet/worksheet.ts`. Test: `web/src/lib/packet/worksheet.test.ts`

- [ ] **Step 1: Failing tests** — assert: DD293 worksheet includes rows for the branch item with the veteran's branch, the discharge-date item, a `SEE ATTACHED STATEMENT` instruction row, and bracketed placeholders for name/SSN; DD149 variant produced when `recommendedForm === 'DD149'`; every row has non-empty `item` and `value`; the requested-characterization row contains the bracketed guidance text.

- [ ] **Step 2: Implement** — `export function buildWorksheet(input: PacketInput): Array<{ item: string; value: string }>` with two literal row tables (DD-293 and DD-149), selected by `input.routing.recommendedForm`. DD-293 rows (item numbering per the DEC 2019 form's major items): applicant name/SSN/address/phone/email placeholders; branch (from facts); discharge date + unit (unit = placeholder); current characterization (from facts); requested change (bracketed guidance); "issues/support" items → `SEE ATTACHED STATEMENT`; counsel → `[None, unless you have one]`; prior applications → placeholder; signature/date → `[Sign and date by hand]`. DD-149 rows analogous (name/SSN/branch/record correction requested → bracketed summary referencing the attached statement; item for "error or injustice" → `SEE ATTACHED STATEMENT`; the JAN 2023 form's date/signature items). Keep every literal string in the row tables — this is attorney-review surface.

- [ ] **Step 3: Commit** — `feat: add form worksheet builder mapping answers to official items`

---

## Task 1: Section builders (pure)

**Files:** Create `web/src/lib/packet/sections.ts`. Test: `web/src/lib/packet/sections.test.ts`

- [ ] **Step 1: Failing tests** — `buildPacketSections(input)` returns sections titled exactly: `Cover Letter` (omitted when `coverLetter` null), `Personal Statement`, `Evidence Index`, `Form Worksheet (DD Form 293)` (or 149), `How to File`; statement body lines preserve paragraph breaks; evidence index renders label+status items and a "none listed yet" body line when empty; the How-to-File section names the official form, the board (from routing), the deadline when `drbWindowOpen`, and contains the sentence fragment `you file it yourself`; NO section contains the strings `legal advice` framed as offering it — assert the disclaimer line `This packet is document assembly, not legal advice.` appears in How to File.

- [ ] **Step 2: Implement** — straightforward builders over `PacketInput`; use `buildWorksheet` for the worksheet section (`item` rows). How-to-File body (verbatim, attorney-review surface):
  1. `Download the official ${formName} from esd.whs.mil (DoD Forms). It opens as a fillable PDF.`
  2. `Fill it item by item using the Form Worksheet in this packet. Where the worksheet says SEE ATTACHED STATEMENT, write exactly that.`
  3. `Print, sign, and date the form by hand (Item ${sigItem}). Unsigned applications are returned.`
  4. `Assemble: signed form on top, then your personal statement, then your evidence in the order of the Evidence Index.`
  5. `Mail to ${boardName} at the address in the form's instructions, or file online where your branch supports it.`
  6. Deadline line when window open: `Your Discharge Review Board window is open until ${drbDeadline}. File before that date.`
  7. `This packet is document assembly, not legal advice. You decide what to file, and you file it yourself.`

- [ ] **Step 3: Commit** — `feat: add packet section builders`

---

## Task 2: PDF renderer

**Files:** Create `web/src/lib/packet/render.ts`. Test: `web/src/lib/packet/render.test.ts`

- [ ] **Step 1: Implement `renderPacket(sections: PacketSection[], meta: { title: string }): Promise<Uint8Array>`** — pdf-lib: Letter pages (612×792), embedded StandardFonts.TimesRoman (+Bold for headings), 72pt margins, greedy word-wrap at measured width (`font.widthOfTextAtSize`), page breaks when cursor passes the bottom margin, `startOnNewPage` honored, per-page footer `Page N of M — generated ${meta.title}` drawn in a second pass, `doc.setTitle(meta.title)`. Item lines render `label:` bold + value wrapped with hanging indent. This is mechanical layout code — keep it one file, no cleverness.

- [ ] **Step 2: Smoke test** — build a small `PacketSection[]`, render, then `PDFDocument.load(bytes)` (pdf-lib CAN load its own output): assert page count ≥ 2 with a forced `startOnNewPage`, title metadata round-trips, byte signature `%PDF`. Also a wrap regression: a 2000-char single-word-free paragraph produces > 1 page when alone.

- [ ] **Step 3: Commit** — `feat: add pdf renderer for packet sections`

---

## Task 3: Download route

**Files:** Create `web/src/app/api/packet/route.ts`. Test: `web/src/app/api/packet/route.test.ts`

- [ ] **Step 1: Failing tests** (mock supabase server client, cases/facts/routing/drafts/evidence libs — same pattern as `route.test.ts`/`coaching-transport.test.ts`): 401 unauthenticated; 409 (JSON error) when facts unconfirmed; 409 when no personal-statement draft; happy path → 200, `content-type: application/pdf`, `content-disposition` contains `recharacter-packet.pdf`, body starts with `%PDF`; routing service down → 503 JSON.

- [ ] **Step 2: Implement GET** — auth → case → `getServiceFacts` (confirmed or 409) → `routeDischarge` (try/catch → 503) → `getDraft(statement)` (or 409) → `getDraft(cover_letter)` (nullable) → evidence rows→labels via `EVIDENCE_CATALOG` → `buildPacketSections` → `renderPacket` → `new NextResponse(bytes, { headers })`. `generatedOn` = `new Date().toISOString().slice(0,10)` here (the route is the impure shell; builders stay pure).

- [ ] **Step 3: Commit** — `feat: add packet download route with readiness gates`

---

## Task 4: Packet page + case wiring

**Files:** Create `web/src/app/case/packet/page.tsx`. Modify `web/src/app/case/page.tsx`.

- [ ] **Step 1: Page** — readiness checklist mirroring the route's gates (facts confirmed ✓/✗ with link to /case/intake; statement drafted ✓/✗ → /case/draft; cover letter optional ✓/—; evidence count); when ready, a plain `<a href="/api/packet">Download your packet (PDF)</a>` button; the official-form guidance block (link text to esd.whs.mil forms page — plain URL, no bytes redistributed); the disclaimer line. When not ready, the download link is not rendered.
- [ ] **Step 2: Wire step 6** — replace `LATER_STEPS`/`['Packet']` remnant with a real section 6 linking `/case/packet` (gated on facts confirmed like others).
- [ ] **Step 3: Full verification** — `npx vitest run` all green; `npm run build` green.
- [ ] **Step 4: Commit** — `feat: add packet page and wire the final wizard step`

---

## Definition of done (Plan 07)

- A veteran with confirmed facts + a drafted statement downloads one PDF: cover letter (when drafted), statement, evidence index, item-numbered worksheet for THEIR form (DD-293 vs DD-149 chosen by routing), and the How-to-File page.
- All section/worksheet content is pure data + pure functions, unit-tested; the renderer round-trips through pdf-lib load.
- The route enforces the gates (401/409/503) and streams `application/pdf`.
- No official-form bytes are redistributed; no coordinate-overlay code exists.
- Full suite + build green; no new tables; no new AI tasks.

## Notes for later plans / deferred

- **Requested-characterization field** (intake addition) — the worksheet placeholder is the marker.
- **Coordinate-overlay filling** (07b, optional): requires flattened backgrounds (DD-149 must be flattened from the XFA hybrid — MuPDF WASM route), hand-calibrated coordinates, and a fingerprint pin on the exact form revision that fails loudly on drift. The scout's field inventories live in the session records; re-scout before attempting.
- Plan 08 (billing) gates `draft_statement`/`draft_cover_letter`/packet download on entitlement.
- Attorney-review surface added this plan: worksheet row literals, How-to-File copy.
