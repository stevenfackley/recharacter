# Evidence Checklist & Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After confirming their facts, a veteran answers four context questions, gets a personalized evidence checklist, tracks collection status per item, and sees a case-strength score with the single highest-leverage gap named — plus optional AI coaching that explains the next step in plain English.

**Architecture:** Two new owner-RLS tables: `case_context` (the four Kurta-relevant answers, one row per case) and `evidence_items` (one row per checklist item). Checklist personalization and the case-strength score are **pure, deterministic functions over a documented weights table** (`web/src/lib/evidence.ts`) — no AI in the scoring path, so the rubric is attorney-reviewable and unit-tested. One new bounded AI task, `coaching_note`, renders the already-computed score/gaps into 2–3 encouraging sentences (prose from structure — never judgment, never advice).

**Tech Stack:** existing stack; no new packages.

**Depends on:** Plan 04 (`service_facts`, gateway library, intake flow) merged.

**Stated assumptions (veto on review):**
- Context questions (MVP): condition category, MST involvement, treated-in-service, has-VA-rating. Enough to personalize meaningfully without a clinical intake.
- The rubric weights live in code as data + are documented in `docs/domain/evidence-rubric.md` for the attorney-review gate. Changing weights is a reviewed edit, not a tuning knob.
- Buddy statements count once toward the score at MVP (no per-statement stacking).
- Linking uploaded documents to evidence items is deferred (evidence status is self-reported at MVP; the storage bucket already exists for Plan 04 uploads).

---

## File structure

```
supabase/migrations/0005_evidence.sql        # case_context + evidence_items
web/src/lib/evidence.ts                      # types, weights, recommend, score
web/src/lib/evidence.test.ts
web/src/lib/context.ts                       # case_context persistence helpers
web/src/lib/ai/tasks.ts                      # + coaching_note task
web/src/app/case/evidence/page.tsx           # context form / checklist / score
web/src/app/case/evidence/actions.ts         # saveContext, setItemStatus, getCoaching
web/src/app/case/page.tsx                    # step 3 wiring
web/tests/evidence-rls.integration.test.ts
docs/domain/evidence-rubric.md               # the attorney-reviewable rubric
```

---

## Task 0: Migration — `case_context` + `evidence_items`

**Files:** Create `supabase/migrations/0005_evidence.sql`

- [ ] **Step 1: Write the migration**

```sql
-- The Kurta-relevant context that personalizes the evidence checklist.
create table public.case_context (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    condition_category text not null check (condition_category in
        ('ptsd','tbi','depression_anxiety','adjustment_disorder','other_mh','unsure')),
    mst_involved boolean not null default false,
    treated_in_service boolean not null default false,
    has_va_rating boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index case_context_owner_idx on public.case_context (owner_id);

grant select, insert, update, delete on public.case_context to authenticated;
revoke truncate on public.case_context from authenticated, anon;

alter table public.case_context enable row level security;
create policy case_context_select_own on public.case_context
    for select using (auth.uid() = owner_id);
create policy case_context_insert_own on public.case_context
    for insert with check (auth.uid() = owner_id);
create policy case_context_update_own on public.case_context
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy case_context_delete_own on public.case_context
    for delete using (auth.uid() = owner_id);

-- One row per recommended checklist item; status is veteran-reported.
create table public.evidence_items (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    item_type text not null check (item_type in
        ('dd214','service_treatment_records','va_rating_letter','civilian_mh_records',
         'buddy_statement','nexus_letter','personal_statement')),
    status text not null default 'needed' check (status in
        ('needed','requested','collected','not_applicable')),
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (case_id, item_type)
);

create index evidence_items_owner_idx on public.evidence_items (owner_id);

grant select, insert, update, delete on public.evidence_items to authenticated;
revoke truncate on public.evidence_items from authenticated, anon;

alter table public.evidence_items enable row level security;
create policy evidence_items_select_own on public.evidence_items
    for select using (auth.uid() = owner_id);
create policy evidence_items_insert_own on public.evidence_items
    for insert with check (auth.uid() = owner_id);
create policy evidence_items_update_own on public.evidence_items
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy evidence_items_delete_own on public.evidence_items
    for delete using (auth.uid() = owner_id);
```

- [ ] **Step 2: Apply and verify** — `supabase db reset`; `supabase db query` both tables `relrowsecurity = t`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_evidence.sql
git commit -m "feat: add case_context and evidence_items tables with RLS"
```

---

## Task 1: The evidence domain — weights, recommendation, score

**Files:** Create `web/src/lib/evidence.ts`. Test: `web/src/lib/evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

`web/src/lib/evidence.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  EVIDENCE_CATALOG, recommendEvidence, scoreCase,
  type CaseContext, type EvidenceStatusMap,
} from '@/lib/evidence'

const baseContext: CaseContext = {
  conditionCategory: 'adjustment_disorder',
  mstInvolved: false,
  treatedInService: false,
  hasVaRating: false,
}

function statuses(collected: string[]): EvidenceStatusMap {
  return Object.fromEntries(collected.map((k) => [k, 'collected' as const]))
}

describe('recommendEvidence', () => {
  test('always includes the universal items', () => {
    const items = recommendEvidence(baseContext).map((i) => i.type)
    for (const t of ['dd214', 'personal_statement', 'buddy_statement', 'nexus_letter']) {
      expect(items).toContain(t)
    }
  })

  test('service treatment records only when treated in service', () => {
    expect(recommendEvidence(baseContext).map((i) => i.type))
      .not.toContain('service_treatment_records')
    expect(recommendEvidence({ ...baseContext, treatedInService: true }).map((i) => i.type))
      .toContain('service_treatment_records')
  })

  test('VA rating letter only when a rating exists', () => {
    expect(recommendEvidence(baseContext).map((i) => i.type)).not.toContain('va_rating_letter')
    expect(recommendEvidence({ ...baseContext, hasVaRating: true }).map((i) => i.type))
      .toContain('va_rating_letter')
  })

  test('MST context flags the own-testimony guidance on the personal statement', () => {
    const ps = recommendEvidence({ ...baseContext, mstInvolved: true })
      .find((i) => i.type === 'personal_statement')!
    expect(ps.guidance).toMatch(/own (statement|testimony)/i)
  })
})

describe('scoreCase', () => {
  test('zero collected scores 0 and names the nexus letter as the top gap', () => {
    const result = scoreCase(recommendEvidence(baseContext), {})
    expect(result.score).toBe(0)
    expect(result.topGap?.type).toBe('nexus_letter') // highest-weight item
  })

  test('everything collected scores 100 with no gap', () => {
    const rec = recommendEvidence({ ...baseContext, treatedInService: true, hasVaRating: true })
    const result = scoreCase(rec, statuses(rec.map((i) => i.type)))
    expect(result.score).toBe(100)
    expect(result.topGap).toBeNull()
  })

  test('score is proportional to collected weight, not item count', () => {
    const rec = recommendEvidence(baseContext)
    const onlyNexus = scoreCase(rec, statuses(['nexus_letter']))
    const onlyDd214 = scoreCase(rec, statuses(['dd214']))
    expect(onlyNexus.score).toBeGreaterThan(onlyDd214.score)
  })

  test('not_applicable items are excluded from the denominator', () => {
    const rec = recommendEvidence(baseContext)
    const withNA = scoreCase(rec, {
      ...statuses(['nexus_letter']),
      civilian_mh_records: 'not_applicable',
    })
    const withoutNA = scoreCase(rec, statuses(['nexus_letter']))
    expect(withNA.score).toBeGreaterThan(withoutNA.score)
  })

  test('bands: building < 40 <= developing < 75 <= strong', () => {
    const rec = recommendEvidence(baseContext)
    expect(scoreCase(rec, {}).band).toBe('building')
    expect(scoreCase(rec, statuses(rec.map((i) => i.type))).band).toBe('strong')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement**

`web/src/lib/evidence.ts`:

```ts
/**
 * The evidence rubric — deterministic and attorney-reviewable (docs/domain/evidence-rubric.md).
 * NO AI in this path: personalization and scoring are pure functions over this data.
 */

export type EvidenceType =
  | 'dd214' | 'service_treatment_records' | 'va_rating_letter' | 'civilian_mh_records'
  | 'buddy_statement' | 'nexus_letter' | 'personal_statement'

export type EvidenceStatus = 'needed' | 'requested' | 'collected' | 'not_applicable'
export type EvidenceStatusMap = Partial<Record<EvidenceType, EvidenceStatus>>

export type CaseContext = {
  conditionCategory: 'ptsd' | 'tbi' | 'depression_anxiety' | 'adjustment_disorder' | 'other_mh' | 'unsure'
  mstInvolved: boolean
  treatedInService: boolean
  hasVaRating: boolean
}

export type EvidenceRecommendation = {
  type: EvidenceType
  label: string
  weight: number
  guidance: string
}

/** Weights sum is irrelevant (score normalizes); RELATIVE size is the rubric. */
export const EVIDENCE_CATALOG: Record<EvidenceType, { label: string; weight: number; guidance: string }> = {
  nexus_letter: {
    label: 'Nexus letter from a mental-health clinician',
    weight: 30,
    guidance:
      'A letter from a mental-health professional connecting your in-service condition to the ' +
      'conduct behind your discharge. The single most persuasive document a petition can include.',
  },
  va_rating_letter: {
    label: 'VA disability rating letter',
    weight: 20,
    guidance: 'Your VA rating decision for the condition — strong corroboration that it exists and is service-connected.',
  },
  service_treatment_records: {
    label: 'Service treatment / in-service mental-health records',
    weight: 15,
    guidance: 'Records from your time in service showing the condition or the events around it.',
  },
  buddy_statement: {
    label: 'Buddy / witness statements',
    weight: 15,
    guidance:
      'Statements from people who saw what happened or saw how you changed. Especially important ' +
      'when the events were unreported or disbelieved at the time.',
  },
  civilian_mh_records: {
    label: 'Civilian mental-health records',
    weight: 10,
    guidance: 'Diagnosis or treatment records from before or after service — they show the trajectory.',
  },
  personal_statement: {
    label: 'Your personal statement',
    weight: 10,
    guidance: 'Your own account, structured around the four questions the board must weigh. Drafted later in this app.',
  },
  dd214: {
    label: 'DD-214 (Certificate of Release or Discharge)',
    weight: 5,
    guidance: 'The baseline document for any petition. You likely already uploaded it during intake.',
  },
}

export function recommendEvidence(ctx: CaseContext): EvidenceRecommendation[] {
  const types: EvidenceType[] = ['dd214', 'personal_statement', 'buddy_statement', 'nexus_letter']
  if (ctx.treatedInService) types.push('service_treatment_records')
  if (ctx.hasVaRating) types.push('va_rating_letter')
  if (ctx.conditionCategory !== 'unsure') types.push('civilian_mh_records')

  return types.map((type) => {
    const base = EVIDENCE_CATALOG[type]
    let guidance = base.guidance
    if (type === 'personal_statement' && ctx.mstInvolved) {
      guidance +=
        ' For MST-related petitions, review boards are directed to accept your own statement as ' +
        'evidence that the experience occurred — the absence of a contemporaneous report does not sink a case.'
    }
    return { type, label: base.label, weight: base.weight, guidance }
  }).sort((a, b) => b.weight - a.weight)
}

export type CaseScore = {
  score: number // 0–100, weight-proportional over applicable items
  band: 'building' | 'developing' | 'strong'
  topGap: EvidenceRecommendation | null
}

export function scoreCase(
  recommended: EvidenceRecommendation[],
  statuses: EvidenceStatusMap,
): CaseScore {
  const applicable = recommended.filter((i) => statuses[i.type] !== 'not_applicable')
  const total = applicable.reduce((s, i) => s + i.weight, 0)
  const collected = applicable
    .filter((i) => statuses[i.type] === 'collected')
    .reduce((s, i) => s + i.weight, 0)

  const score = total === 0 ? 0 : Math.round((collected / total) * 100)
  const band = score >= 75 ? 'strong' : score >= 40 ? 'developing' : 'building'
  const topGap = applicable
    .filter((i) => statuses[i.type] !== 'collected')
    .sort((a, b) => b.weight - a.weight)[0] ?? null

  return { score, band, topGap }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (10).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/evidence.ts web/src/lib/evidence.test.ts
git commit -m "feat: add deterministic evidence rubric with recommendation and scoring"
```

---

## Task 2: Rubric documentation (attorney-review surface)

**Files:** Create `docs/domain/evidence-rubric.md`

- [ ] **Step 1: Write the doc** — a table of the seven items with weights and one-line rationale each (mirror `EVIDENCE_CATALOG` exactly), the personalization rules (which context answers add which items), the score formula (`collected weight / applicable weight`, N/A excluded), the bands (<40 building, 40–74 developing, ≥75 strong), the MST own-testimony note with its Kurta basis, and a header stating: *"This rubric is product guidance about evidence completeness, not a prediction of board outcomes. Attorney review required before launch; changes to weights are reviewed edits."*

- [ ] **Step 2: Commit**

```bash
git add docs/domain/evidence-rubric.md
git commit -m "docs: document the evidence rubric for attorney review"
```

---

## Task 3: Context persistence + `coaching_note` AI task

**Files:** Create `web/src/lib/context.ts`. Modify `web/src/lib/ai/tasks.ts` (+tests).

- [ ] **Step 1: Context helpers**

`web/src/lib/context.ts`:

```ts
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { CaseContext } from '@/lib/evidence'

export const caseContextSchema = z.object({
  conditionCategory: z.enum(['ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure']),
  mstInvolved: z.boolean(),
  treatedInService: z.boolean(),
  hasVaRating: z.boolean(),
})

export async function getCaseContext(caseId: string): Promise<CaseContext | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('case_context').select('*').eq('case_id', caseId).maybeSingle()
  if (!data) return null
  return {
    conditionCategory: data.condition_category,
    mstInvolved: data.mst_involved,
    treatedInService: data.treated_in_service,
    hasVaRating: data.has_va_rating,
  }
}

export async function saveCaseContext(caseId: string, ctx: CaseContext): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('case_context').upsert(
    {
      case_id: caseId,
      owner_id: user.id,
      condition_category: ctx.conditionCategory,
      mst_involved: ctx.mstInvolved,
      treated_in_service: ctx.treatedInService,
      has_va_rating: ctx.hasVaRating,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id' },
  )
  if (error) throw error
}
```

- [ ] **Step 2: Failing tests for the task** (append to `tasks.test.ts` describe block)

```ts
  test('coaching_note validates its structured input', () => {
    const coaching = getTask('coaching_note')!
    expect(() => coaching.buildPrompt({ score: 'high' })).toThrow()
    const prompt = coaching.buildPrompt({
      score: 35, band: 'building',
      topGapLabel: 'Nexus letter from a mental-health clinician',
      collectedLabels: ['DD-214'],
    }) as string
    expect(prompt).toContain('35')
    expect(prompt).toContain('Nexus letter')
  })

  test('coaching_note output is a bounded note', () => {
    const coaching = getTask('coaching_note')!
    expect(coaching.outputSchema.safeParse({ note: 'Keep going.' }).success).toBe(true)
    expect(coaching.outputSchema.safeParse({ advice: 'sue them' }).success).toBe(false)
  })
```

- [ ] **Step 3: Implement the task** (in `tasks.ts`; register in `TASKS`)

```ts
const coachingInput = z.object({
  score: z.number().int().min(0).max(100),
  band: z.enum(['building', 'developing', 'strong']),
  topGapLabel: z.string().nullable(),
  collectedLabels: z.array(z.string()).max(10),
})

const coachingOutput = z.object({ note: z.string().min(1).max(800) })

const coaching_note: AiTask = {
  name: 'coaching_note',
  model: 'claude-opus-4-8',
  system:
    'You write a short, warm, plain-English encouragement note for a veteran assembling ' +
    'evidence for a discharge-upgrade petition, inside a document-assembly application. ' +
    'You are given a completeness score, its band, what they have collected, and the single ' +
    'highest-value missing item. Write 2-3 sentences: acknowledge progress specifically, then ' +
    'point at the one next step. Never predict outcomes, never give legal advice or strategy, ' +
    'never mention lawyers or deadlines. The note is informational encouragement only.',
  maxTokens: 512,
  inputSchema: coachingInput,
  outputSchema: coachingOutput,
  jsonSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { score, band, topGapLabel, collectedLabels } = coachingInput.parse(input)
    return (
      `Completeness score: ${score}/100 (${band}). ` +
      `Collected so far: ${collectedLabels.length ? collectedLabels.join('; ') : 'nothing yet'}. ` +
      `Highest-value missing item: ${topGapLabel ?? 'none — everything applicable is collected'}.`
    )
  },
}
```

- [ ] **Step 4: Run** — `npx vitest run src/lib/ai/tasks.test.ts` → all PASS (drift test auto-covers the new task).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/context.ts web/src/lib/ai/tasks.ts web/src/lib/ai/tasks.test.ts
git commit -m "feat: add case context helpers and bounded coaching_note task"
```

---

## Task 4: RLS integration tests

**Files:** Create `web/tests/evidence-rls.integration.test.ts`

- [ ] **Step 1: Write the test** — reuse the two-user harness from `web/tests/rls.integration.test.ts` verbatim (emails prefixed `ev_`). Alice creates (or 23505-reuses) her case row first. Tests:
1. Alice inserts+reads her own `case_context` row; Bob sees `[]`.
2. Bob cannot spoof-insert `case_context` with `owner_id: alice.id` (error non-null).
3. Alice inserts an `evidence_items` row (`item_type: 'nexus_letter'`); Bob sees `[]`; Bob's update of Alice's row via `.eq('owner_id', alice.id).select()` → `[]`.
4. Duplicate `(case_id, item_type)` insert errors `23505`.

- [ ] **Step 2: Run** (stack up) → PASS. Isolation failure = STOP, fix migration.

- [ ] **Step 3: Commit**

```bash
git add web/tests/evidence-rls.integration.test.ts
git commit -m "test: prove RLS isolation for case_context and evidence_items"
```

---

## Task 5: Evidence actions + page

**Files:** Create `web/src/app/case/evidence/actions.ts`, `web/src/app/case/evidence/page.tsx`

- [ ] **Step 1: Server actions**

`web/src/app/case/evidence/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateCase } from '@/lib/cases'
import { caseContextSchema, saveCaseContext } from '@/lib/context'
import { executeAiTask } from '@/lib/ai/gateway'

export async function saveContext(formData: FormData) {
  const parsed = caseContextSchema.safeParse({
    conditionCategory: String(formData.get('conditionCategory') ?? ''),
    mstInvolved: formData.get('mstInvolved') === 'on',
    treatedInService: formData.get('treatedInService') === 'on',
    hasVaRating: formData.get('hasVaRating') === 'on',
  })
  if (!parsed.success) redirect('/case/evidence?error=' + encodeURIComponent('Check the form'))

  const c = await getOrCreateCase()
  await saveCaseContext(c.id, parsed.data)
  redirect('/case/evidence')
}

const STATUSES = ['needed', 'requested', 'collected', 'not_applicable']

export async function setItemStatus(formData: FormData) {
  const itemType = String(formData.get('itemType') ?? '')
  const status = String(formData.get('status') ?? '')
  if (!STATUSES.includes(status)) redirect('/case/evidence')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const { error } = await supabase.from('evidence_items').upsert(
    {
      case_id: c.id, owner_id: user!.id, item_type: itemType,
      status, updated_at: new Date().toISOString(),
    },
    { onConflict: 'case_id,item_type' },
  )
  if (error) redirect('/case/evidence?error=' + encodeURIComponent('Could not save — try again'))
  revalidatePath('/case/evidence')
}

/** Optional AI encouragement — renders the DETERMINISTIC score/gap into prose. */
export async function getCoaching(input: {
  score: number; band: 'building' | 'developing' | 'strong'
  topGapLabel: string | null; collectedLabels: string[]
}): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const result = await executeAiTask(supabase, user.id, 'coaching_note', input)
  return result.ok ? (result.data as { note: string }).note : null
}
```

- [ ] **Step 2: Page**

`web/src/app/case/evidence/page.tsx` — server component:
1. `getOrCreateCase()`; `getCaseContext(c.id)`. If **no context**: render the four-question form (`select` for condition category with the six options; three checkboxes; submit → `saveContext`) and stop.
2. With context: `recommendEvidence(ctx)`; load `evidence_items` rows for the case into an `EvidenceStatusMap`; `scoreCase(recommended, statuses)`.
3. Render: score + band (`<strong>{score}/100</strong> — {band}`), the top-gap callout (`Your highest-value next step: {topGap.label}` + its guidance) when present, then the checklist — each item: label, guidance, and a small form per status option (four submit buttons or a select + save button posting `setItemStatus` with hidden `itemType`).
4. A "Why these items?" line linking the rubric doc philosophy: "This checklist and score measure completeness of your evidence — they do not predict any board's decision."
5. An "Encourage me" form posting to a server action that calls `getCoaching(...)` and renders the note (skip silently if it returns null — e.g. no AI key configured).
6. Link back to `/case`.

- [ ] **Step 3: Build check** — `npm run build` → green.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/case/evidence
git commit -m "feat: add evidence checklist page with context form and case score"
```

---

## Task 6: Case-page wiring + full verification

**Files:** Modify `web/src/app/case/page.tsx`

- [ ] **Step 1: Wire step 3** — replace the `Evidence — not started` entry in `LATER_STEPS` rendering: change `LATER_STEPS` to `['Nexus', 'Draft', 'Coaching', 'Packet']` (now `<ol start={4}>`) and add a section 3 mirroring sections 1–2's pattern:

```tsx
      <section>
        <h2>3. Evidence</h2>
        {facts?.confirmed ? (
          <p><Link href="/case/evidence">Build your evidence checklist</Link></p>
        ) : (
          <p>Confirm your service facts first.</p>
        )}
      </section>
```

- [ ] **Step 2: Full verification** — from `web/` (stack up): `npx vitest run` → ALL green (Plan 04 total + evidence 10 + tasks +2 + evidence-RLS 4 ≈ 65). `npm run build` → green.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/case/page.tsx
git commit -m "feat: wire the evidence step into the case page"
```

---

## Definition of done (Plan 05)

- Migrations apply; both tables RLS-proven by two-user tests.
- The rubric is pure data + pure functions, unit-tested (personalization rules, weight-proportional scoring, N/A exclusion, top-gap selection, bands), and documented for attorney review.
- A veteran with confirmed facts can: answer the four context questions → see a personalized checklist → toggle item statuses → watch the score and top-gap update.
- `coaching_note` is registered, drift-pinned, and never in the scoring path; the page works fully without an AI key.
- Full suite + build green.

## Notes for later plans

- Plan 06 (nexus/draft) consumes `case_context` (condition, MST) and the collected-evidence list to seed the Kurta interview.
- Buddy-statement and nexus-letter request templates (letters the veteran hands to witnesses/clinicians) are natural Plan 06 additions.
- Document-to-evidence-item linking + retention/deletion UI still deferred.
