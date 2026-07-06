# Nexus Builder & Statement Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The veteran answers the Kurta memo's four questions through a guided interview (with optional AI help shaping *their own words*), then generates an editable personal statement and cover letter assembled from those answers — the documents at the center of the petition packet.

**Architecture:** Two owner-RLS tables: `nexus_answers` (the four Kurta slots as veteran-owned text, one row per case) and `drafts` (`personal_statement` / `cover_letter` per case, always editable). Two new bounded AI tasks: `shape_nexus_answer` (restructures the veteran's raw narrative for ONE question — preserves their words, invents nothing, flags gaps) and `draft_statement` (assembles the statement exclusively from the four approved answers + confirmed facts + collected evidence — it formats and connects; it cannot add facts). The saved artifact is always the veteran's editable text; AI output is only ever a proposal the veteran accepts or edits. Draft generation requires all four answers complete.

**Tech Stack:** existing stack; no new packages.

**Depends on:** Plan 05 merged (`case_context`, evidence items feed the drafting input).

**Stated assumptions (veto on review):**
- The four questions use plain-language phrasings of the Kurta criteria (exact copy below) with the memo's own framing in explainer text — this copy is part of the attorney-review surface.
- `shape_nexus_answer` is optional per question — a veteran can write and save answers with zero AI involvement; the whole nexus/draft flow works without an AI key EXCEPT draft generation itself (which is inherently an AI feature; without a key the page explains that and the veteran can write their statement manually in the editor).
- Cover letter needs routing (board name/form), so it requires confirmed facts + reachable .NET service at generation time; the statement does not.
- Regeneration overwrites the draft only after an explicit confirm field; an `edited` flag warns when regenerating over human edits.

---

## File structure

```
supabase/migrations/0006_nexus_drafts.sql
web/src/lib/nexus.ts                        # question definitions + persistence
web/src/lib/nexus.test.ts
web/src/lib/drafts.ts                       # drafts persistence
web/src/lib/ai/tasks.ts                     # + shape_nexus_answer, draft_statement, draft_cover_letter
web/src/app/case/nexus/page.tsx             # the four-question interview
web/src/app/case/nexus/actions.ts           # saveAnswer, shapeAnswer
web/src/app/case/draft/page.tsx             # generate/edit statement + cover letter
web/src/app/case/draft/actions.ts           # generateStatement, generateCoverLetter, saveDraft
web/src/app/case/page.tsx                   # steps 4-5 wiring
web/tests/nexus-rls.integration.test.ts
```

---

## Task 0: Migration — `nexus_answers` + `drafts`

**Files:** Create `supabase/migrations/0006_nexus_drafts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- The four Kurta slots, one row per case. Text is ALWAYS the veteran's own
-- editable words (AI may propose phrasing; only accepted text lands here).
create table public.nexus_answers (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    q1_condition text not null default '',
    q2_during_service text not null default '',
    q3_mitigation text not null default '',
    q4_outweigh text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index nexus_answers_owner_idx on public.nexus_answers (owner_id);

grant select, insert, update, delete on public.nexus_answers to authenticated;
revoke truncate on public.nexus_answers from authenticated, anon;

alter table public.nexus_answers enable row level security;
create policy nexus_answers_select_own on public.nexus_answers
    for select using (auth.uid() = owner_id);
create policy nexus_answers_insert_own on public.nexus_answers
    for insert with check (auth.uid() = owner_id);
create policy nexus_answers_update_own on public.nexus_answers
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy nexus_answers_delete_own on public.nexus_answers
    for delete using (auth.uid() = owner_id);

-- Generated-then-edited documents. content is the veteran's working copy.
create table public.drafts (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    kind text not null check (kind in ('personal_statement','cover_letter')),
    content text not null,
    edited boolean not null default false,
    generated_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (case_id, kind)
);

create index drafts_owner_idx on public.drafts (owner_id);

grant select, insert, update, delete on public.drafts to authenticated;
revoke truncate on public.drafts from authenticated, anon;

alter table public.drafts enable row level security;
create policy drafts_select_own on public.drafts
    for select using (auth.uid() = owner_id);
create policy drafts_insert_own on public.drafts
    for insert with check (auth.uid() = owner_id);
create policy drafts_update_own on public.drafts
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy drafts_delete_own on public.drafts
    for delete using (auth.uid() = owner_id);
```

- [ ] **Step 2: Apply and verify** — `supabase db reset`; both tables `relrowsecurity = t` via `supabase db query`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_nexus_drafts.sql
git commit -m "feat: add nexus_answers and drafts tables with RLS"
```

---

## Task 1: Nexus domain — questions + persistence

**Files:** Create `web/src/lib/nexus.ts`. Test: `web/src/lib/nexus.test.ts`

- [ ] **Step 1: Write the failing test**

`web/src/lib/nexus.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { KURTA_QUESTIONS, answersComplete, type NexusAnswers } from '@/lib/nexus'

describe('KURTA_QUESTIONS', () => {
  test('there are exactly four, keyed q1-q4, each with prompt and explainer', () => {
    expect(KURTA_QUESTIONS.map((q) => q.key)).toEqual(['q1', 'q2', 'q3', 'q4'])
    for (const q of KURTA_QUESTIONS) {
      expect(q.prompt.length).toBeGreaterThan(10)
      expect(q.explainer.length).toBeGreaterThan(10)
    }
  })
})

describe('answersComplete', () => {
  const full: NexusAnswers = {
    q1_condition: 'I developed an adjustment disorder…',
    q2_during_service: 'It began during my second year…',
    q3_mitigation: 'The conduct happened because…',
    q4_outweigh: 'My service before the incidents…',
  }

  test('true only when all four have substantive text', () => {
    expect(answersComplete(full)).toBe(true)
    expect(answersComplete({ ...full, q3_mitigation: '' })).toBe(false)
    expect(answersComplete({ ...full, q4_outweigh: '   ' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement**

`web/src/lib/nexus.ts`:

```ts
import { createClient } from '@/lib/supabase/server'

export type NexusAnswers = {
  q1_condition: string
  q2_during_service: string
  q3_mitigation: string
  q4_outweigh: string
}

export type KurtaKey = 'q1' | 'q2' | 'q3' | 'q4'

/**
 * Plain-language phrasings of the Kurta memo's four questions. The explainer
 * copy is part of the attorney-review surface before launch.
 */
export const KURTA_QUESTIONS: Array<{
  key: KurtaKey
  column: keyof NexusAnswers
  prompt: string
  explainer: string
}> = [
  {
    key: 'q1',
    column: 'q1_condition',
    prompt: 'What condition or experience do you believe affected you?',
    explainer:
      'The board first asks whether you had a condition or experience that may excuse or ' +
      'mitigate your discharge — for example PTSD, TBI, another mental-health condition, or ' +
      'military sexual trauma. Describe it in your own words. A formal diagnosis helps but is ' +
      'not required to apply.',
  },
  {
    key: 'q2',
    column: 'q2_during_service',
    prompt: 'When did it start or happen, and what was going on in your service at the time?',
    explainer:
      'The board next asks whether the condition existed — or the experience occurred — during ' +
      'your military service. Describe the timeline: when things started, what happened around ' +
      'you, who (if anyone) you told.',
  },
  {
    key: 'q3',
    column: 'q3_mitigation',
    prompt: 'How did it connect to the conduct that led to your discharge?',
    explainer:
      'This is the heart of the petition — the nexus. The board asks whether the condition or ' +
      'experience actually excuses or mitigates the conduct behind your discharge. Connect the ' +
      'two as directly as you can: what you were experiencing, and how it showed up in the ' +
      'events that led to separation.',
  },
  {
    key: 'q4',
    column: 'q4_outweigh',
    prompt: 'Looking at your whole record, why should this outweigh the discharge?',
    explainer:
      'Finally, the board weighs whether the condition or experience outweighs the discharge. ' +
      'This is where your whole story counts: your service before the incidents, what you have ' +
      'done since, treatment, work, family, community.',
  },
]

export function answersComplete(a: NexusAnswers): boolean {
  return [a.q1_condition, a.q2_during_service, a.q3_mitigation, a.q4_outweigh]
    .every((t) => t.trim().length > 0)
}

export async function getNexusAnswers(caseId: string): Promise<NexusAnswers | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('nexus_answers').select('*').eq('case_id', caseId).maybeSingle()
  if (!data) return null
  return {
    q1_condition: data.q1_condition,
    q2_during_service: data.q2_during_service,
    q3_mitigation: data.q3_mitigation,
    q4_outweigh: data.q4_outweigh,
  }
}

export async function saveNexusAnswer(
  caseId: string,
  column: keyof NexusAnswers,
  text: string,
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('nexus_answers').upsert(
    {
      case_id: caseId,
      owner_id: user.id,
      [column]: text,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (2 tests, 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/nexus.ts web/src/lib/nexus.test.ts
git commit -m "feat: add Kurta question definitions and nexus persistence"
```

---

## Task 2: Drafts persistence

**Files:** Create `web/src/lib/drafts.ts` (small; covered by RLS tests + build)

- [ ] **Step 1: Implement**

```ts
import { createClient } from '@/lib/supabase/server'

export type DraftKind = 'personal_statement' | 'cover_letter'

export type Draft = {
  kind: DraftKind
  content: string
  edited: boolean
  generated_at: string
}

export async function getDraft(caseId: string, kind: DraftKind): Promise<Draft | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('drafts').select('kind, content, edited, generated_at')
    .eq('case_id', caseId).eq('kind', kind).maybeSingle()
  return (data as Draft | null) ?? null
}

/** Writes a freshly GENERATED draft (resets edited=false). */
export async function saveGeneratedDraft(caseId: string, kind: DraftKind, content: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase.from('drafts').upsert(
    {
      case_id: caseId, owner_id: user.id, kind, content,
      edited: false, generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id,kind' },
  )
  if (error) throw error
}

/** Writes the veteran's EDITED text (sets edited=true, preserves generated_at). */
export async function saveEditedDraft(caseId: string, kind: DraftKind, content: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase.from('drafts')
    .update({ content, edited: true, updated_at: new Date().toISOString() })
    .eq('case_id', caseId).eq('kind', kind).eq('owner_id', user.id)
  if (error) throw error
}
```

- [ ] **Step 2: `npx tsc --noEmit`** clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/drafts.ts
git commit -m "feat: add drafts persistence with generated-vs-edited tracking"
```

---

## Task 3: The two drafting AI tasks

**Files:** Modify `web/src/lib/ai/tasks.ts` + `web/src/lib/ai/tasks.test.ts`

- [ ] **Step 1: Failing tests** (append inside the describe block)

```ts
  test('shape_nexus_answer validates input and embeds the narrative', () => {
    const shape = getTask('shape_nexus_answer')!
    expect(() => shape.buildPrompt({ questionKey: 'q9', rawNarrative: 'x' })).toThrow()
    const prompt = shape.buildPrompt({
      questionKey: 'q3',
      questionPrompt: 'How did it connect to the conduct that led to your discharge?',
      rawNarrative: 'I was being threatened daily and stopped sleeping...',
    }) as string
    expect(prompt).toContain('threatened daily')
  })

  test('shape_nexus_answer output shape', () => {
    const shape = getTask('shape_nexus_answer')!
    expect(shape.outputSchema.safeParse({
      shapedAnswer: 'During my second year...', gaps: 'Consider adding dates.',
    }).success).toBe(true)
  })

  test('draft_statement requires all four answers', () => {
    const draft = getTask('draft_statement')!
    expect(() => draft.buildPrompt({
      answers: { q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c' },
    })).toThrow()
  })

  test('draft_cover_letter embeds board and form', () => {
    const cover = getTask('draft_cover_letter')!
    const prompt = cover.buildPrompt({
      boardName: 'NDRB', form: 'DD293',
      branch: 'MarineCorps', characterization: 'OtherThanHonorable',
      conditionSummary: 'adjustment disorder arising in service',
    }) as string
    expect(prompt).toContain('NDRB')
    expect(prompt).toContain('DD293')
  })
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement the three tasks** (register all in `TASKS`)

```ts
const shapeInput = z.object({
  questionKey: z.enum(['q1', 'q2', 'q3', 'q4']),
  questionPrompt: z.string().min(1).max(500),
  rawNarrative: z.string().min(1).max(8000),
})
const shapeOutput = z.object({
  shapedAnswer: z.string().min(1).max(6000),
  gaps: z.string().max(1000),
})

const shape_nexus_answer: AiTask = {
  name: 'shape_nexus_answer',
  model: 'claude-opus-4-8',
  system:
    'You help a veteran phrase their OWN account for one specific question a discharge review ' +
    'board weighs, inside a document-assembly application. Rewrite their raw narrative into a ' +
    'clear, first-person answer to the question. RULES: preserve their voice and their words ' +
    'wherever possible; NEVER add facts, events, dates, diagnoses, or details they did not ' +
    'state; do not exaggerate; do not give advice or legal argument. In gaps, note (one or two ' +
    'sentences, addressed to the veteran) what a reader might still wonder — phrased as ' +
    '"consider describing…", never as instructions about strategy. The veteran will edit and ' +
    'own the final text.',
  maxTokens: 2048,
  inputSchema: shapeInput,
  outputSchema: shapeOutput,
  jsonSchema: {
    type: 'object',
    properties: { shapedAnswer: { type: 'string' }, gaps: { type: 'string' } },
    required: ['shapedAnswer', 'gaps'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { questionPrompt, rawNarrative } = shapeInput.parse(input)
    return `The question: ${questionPrompt}\n\nThe veteran's raw account:\n${rawNarrative}`
  },
}

const draftAnswers = z.object({
  q1_condition: z.string().min(1).max(6000),
  q2_during_service: z.string().min(1).max(6000),
  q3_mitigation: z.string().min(1).max(6000),
  q4_outweigh: z.string().min(1).max(6000),
})
const draftInput = z.object({
  answers: draftAnswers,
  branch: z.enum(BRANCH_VALUES),
  characterization: z.enum(CHARACTERIZATION_VALUES),
  dischargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  collectedEvidence: z.array(z.string().max(120)).max(10),
})
const draftOutput = z.object({ statement: z.string().min(1) })

const draft_statement: AiTask = {
  name: 'draft_statement',
  model: 'claude-opus-4-8',
  system:
    'You assemble a personal statement for a veteran petitioning a discharge review board, ' +
    'inside a document-assembly application. You are given the veteran\'s four approved answers ' +
    '(their own words), their confirmed service facts, and a list of evidence they are including. ' +
    'Produce a complete first-person statement: a brief opening identifying the service and the ' +
    'characterization being petitioned; the four answers woven into a coherent narrative in ' +
    'their original order; a short closing that respectfully asks the board to apply liberal ' +
    'consideration to the mental-health evidence. RULES: the statement may contain ONLY facts ' +
    'present in the inputs — never invent events, dates, names, diagnoses, or details; preserve ' +
    'the veteran\'s voice and words wherever possible; plain language, no citations, no legal ' +
    'argument beyond the liberal-consideration request; do not address filing strategy. The ' +
    'veteran will review, edit, and own this draft.',
  maxTokens: 8192,
  inputSchema: draftInput,
  outputSchema: draftOutput,
  jsonSchema: {
    type: 'object',
    properties: { statement: { type: 'string' } },
    required: ['statement'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const d = draftInput.parse(input)
    return (
      `Service facts: branch ${d.branch}; discharged ${d.dischargeDate}; characterization ${d.characterization}.\n` +
      `Evidence being included: ${d.collectedEvidence.length ? d.collectedEvidence.join('; ') : 'listed separately'}.\n\n` +
      `Answer 1 — the condition/experience:\n${d.answers.q1_condition}\n\n` +
      `Answer 2 — during service:\n${d.answers.q2_during_service}\n\n` +
      `Answer 3 — connection to the conduct (nexus):\n${d.answers.q3_mitigation}\n\n` +
      `Answer 4 — whole record:\n${d.answers.q4_outweigh}`
    )
  },
}

const coverInput = z.object({
  boardName: z.string().min(1).max(40),
  form: z.enum(['DD293', 'DD149']),
  branch: z.enum(BRANCH_VALUES),
  characterization: z.enum(CHARACTERIZATION_VALUES),
  conditionSummary: z.string().min(1).max(300),
})
const coverOutput = z.object({ letter: z.string().min(1) })

const draft_cover_letter: AiTask = {
  name: 'draft_cover_letter',
  model: 'claude-opus-4-8',
  system:
    'You draft a short, formal cover letter for a discharge-upgrade application packet, inside ' +
    'a document-assembly application. One page maximum: addressee is the named review board; ' +
    'state the enclosed application form, the relief requested (upgrade of the characterization), ' +
    'a one-sentence summary of the mental-health basis with a respectful request for liberal ' +
    'consideration, and an enclosures line. Use placeholders in square brackets for anything not ' +
    'provided (name, address, date, signature). RULES: only facts from the input; no legal ' +
    'argument; plain, respectful, formal register. The veteran will review, edit, and own it.',
  maxTokens: 2048,
  inputSchema: coverInput,
  outputSchema: coverOutput,
  jsonSchema: {
    type: 'object',
    properties: { letter: { type: 'string' } },
    required: ['letter'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const d = coverInput.parse(input)
    return (
      `Board: ${d.boardName}. Form enclosed: ${d.form}. Branch: ${d.branch}. ` +
      `Current characterization: ${d.characterization}. ` +
      `Mental-health basis (one sentence): ${d.conditionSummary}.`
    )
  },
}
```

- [ ] **Step 4: Run all task tests** — PASS (drift test auto-covers all three).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/ai/tasks.ts web/src/lib/ai/tasks.test.ts
git commit -m "feat: add nexus shaping and statement drafting tasks"
```

---

## Task 4: RLS integration tests

**Files:** Create `web/tests/nexus-rls.integration.test.ts` — two-user harness (emails `nx_`), Alice creates/reuses her case first. Tests: (1) Alice inserts+reads her `nexus_answers`; Bob sees `[]`. (2) Bob cannot spoof-insert for Alice (error non-null). (3) Alice inserts a `drafts` row (`kind: 'personal_statement'`); Bob sees `[]`; Bob's cross-user update → `[]`. (4) Duplicate `(case_id, kind)` draft insert errors `23505`.

- [ ] Run (stack up) → PASS; commit:

```bash
git add web/tests/nexus-rls.integration.test.ts
git commit -m "test: prove RLS isolation for nexus_answers and drafts"
```

---

## Task 5: Nexus interview page + actions

**Files:** Create `web/src/app/case/nexus/actions.ts`, `web/src/app/case/nexus/page.tsx`

- [ ] **Step 1: Actions** — `saveAnswer(formData)` (fields: `column` ∈ the four column names — validate against an allowlist, `text` ≤ 8000 chars; `saveNexusAnswer`; redirect `/case/nexus?saved=<key>`). `shapeAnswer(formData)` (fields: `questionKey`, `questionPrompt` resolved server-side from `KURTA_QUESTIONS` by key — do NOT trust a client-provided prompt — and `rawNarrative`; calls `executeAiTask('shape_nexus_answer', …)`; on success redirect with the shaped text placed in the DB? NO — shaped text is a PROPOSAL: render it back into the textarea WITHOUT saving. Since server actions redirect, persist the proposal in the row's column ONLY when the veteran presses Save; to carry the proposal to the re-render, save it to the answer column immediately BUT the page marks it as unsaved-proposal? Simplest honest MVP: `shapeAnswer` writes the shaped text into the column like a normal save (it IS the veteran's narrative, restructured, and remains fully editable in the same textarea) and redirects `/case/nexus?shaped=<key>&gaps=<encoded gaps ≤200 chars>` — gaps is coaching copy, not PII. The veteran continues editing and saving normally.)
- [ ] **Step 2: Page** — for each of `KURTA_QUESTIONS`: explainer, a form with a textarea (prefilled from `getNexusAnswers`), Save button (`saveAnswer`), and a second small form "Help me phrase this" (`shapeAnswer`, disabled hint when textarea empty — submit the current text via a shared hidden field is not possible across forms; instead the shape form includes its own textarea? Simplest: ONE form per question with two submit buttons — `formAction={saveAnswer}` and `formAction={shapeAnswer}` on the buttons, sharing the same textarea field. Use that.) Show `?gaps=` note when present ("Something to consider: …"). Progress indicator "N of 4 answered" via `answersComplete` per-field check. Link to `/case/draft` when all four complete.
- [ ] **Step 3: Build check; commit**

```bash
git add web/src/app/case/nexus
git commit -m "feat: add Kurta nexus interview with optional AI phrasing help"
```

---

## Task 6: Draft page + actions

**Files:** Create `web/src/app/case/draft/actions.ts`, `web/src/app/case/draft/page.tsx`

- [ ] **Step 1: Actions**
  - `generateStatement()`: auth; case; require `answersComplete` (else redirect `/case/nexus`); require confirmed facts (else `/case/intake`); gather collected evidence labels (query `evidence_items` where `status='collected'`, map via `EVIDENCE_CATALOG`); `executeAiTask('draft_statement', …)`; on ok → `saveGeneratedDraft(case, 'personal_statement', statement)`; redirect `/case/draft`. On !ok → redirect with error ("Drafting needs an AI key — you can also write your statement directly below" when status 503).
  - `generateCoverLetter()`: additionally `routeDischarge(facts)` for boardName/form (503-style error if unreachable); `conditionSummary` derived from `case_context.condition_category` via a small label map + "arising during service" (no free text).
  - `saveDraft(formData)`: `kind` allowlist + `content` ≤ 50k chars → `saveEditedDraft`.
  - Regenerate: `generateStatement` overwrites only when the existing draft has `edited=false` OR the form posted `confirm=on`; else redirect `?confirm=statement` prompting the checkbox.
- [ ] **Step 2: Page** — two sections (Personal statement / Cover letter): if no draft → explain what will be generated + Generate button (cover letter section notes it needs confirmed facts); if draft → `<textarea name="content">` prefilled, Save edits button, Generate-again form with confirm checkbox when `edited`, "generated {date}, edited" status line. Banner: "These are drafts you own. Read every word; change anything that isn't right. Nothing is filed until you file it."
- [ ] **Step 3: Wire `/case`** — `LATER_STEPS` shrinks to `['Coaching', 'Packet']` (ol start 6); add sections 4 (Nexus — link when facts confirmed, "N of 4" status) and 5 (Draft — link when nexus complete). NOTE: coaching became part of Plan 05's evidence step; if `LATER_STEPS` already shrank, adjust to keep numbering coherent (`['Packet']`).
- [ ] **Step 4: Full verification** — `npx vitest run` all green (~+8 over Plan 05's total); `npm run build` green.
- [ ] **Step 5: Commit**

```bash
git add web/src/app/case/draft web/src/app/case/page.tsx
git commit -m "feat: add statement and cover letter drafting with veteran-owned editing"
```

---

## Definition of done (Plan 06)

- Both tables RLS-proven; migrations apply cleanly.
- A veteran can answer all four Kurta questions with zero AI involvement; the shape helper, when used, only restructures their words and its proposal remains fully editable.
- Draft generation requires: all four answers + confirmed facts (+ reachable routing service for the cover letter). Generated drafts are editable; edits are never silently overwritten (regenerate requires explicit confirm once edited).
- The drafting prompts forbid invented facts and legal argument; every prompt is part of the attorney-review surface.
- Full suite + build green; the drift test covers all three new tasks.

## Notes for later plans

- Plan 07 (packet) consumes `drafts` (statement + cover letter) + evidence list + routing for the assembled PDF.
- Buddy-statement / nexus-letter request templates remain a candidate addition.
- The `?gaps=` coaching hint keeps AI-generated text out of the DB until accepted — revisit if gaps notes grow.
