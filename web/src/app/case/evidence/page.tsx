import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSessionUser } from '@/lib/session'
import { getOrCreateCase } from '@/lib/cases'
import { getCaseContext } from '@/lib/context'
import { getEvidenceStatuses } from '@/lib/evidence-items'
import { recommendEvidence, scoreCase } from '@/lib/evidence'
import { evidenceStatusLabel } from '@/lib/labels'
import { saveContext, setItemStatus } from './actions'
import { CoachingSection } from './coaching'

export const metadata: Metadata = { title: 'Your evidence checklist' }

/** Closed set: only these codes resolve to copy, never `params.error` itself. */
const ERRORS = {
  save_failed: 'Could not save that — try again shortly.',
  invalid_context: 'Check the form.',
} as const

const CONDITION_OPTIONS = [
  { value: 'ptsd', label: 'PTSD' },
  { value: 'tbi', label: 'Traumatic brain injury (TBI)' },
  { value: 'depression_anxiety', label: 'Depression or anxiety' },
  { value: 'adjustment_disorder', label: 'Adjustment disorder' },
  { value: 'other_mh', label: 'Other mental-health condition' },
  { value: 'unsure', label: 'Not sure' },
] as const

const STATUS_OPTIONS = ['needed', 'requested', 'collected', 'not_applicable'] as const

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const user = await requireSessionUser('/case/evidence')
  const c = await getOrCreateCase(user.id)
  const ctx = await getCaseContext(user.id, c.id)

  const error = ERRORS[params.error as keyof typeof ERRORS] ?? null

  if (!ctx) {
    return (
      <main>
        <h1>Tell us about your case</h1>
        {error && <p role="alert">{error}</p>}
        <p>Four quick questions personalize the evidence checklist below.</p>

        <form action={saveContext}>
          <label>
            Condition category
            <select name="conditionCategory" defaultValue="" required>
              <option value="" disabled>Select…</option>
              {CONDITION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>
            <input name="mstInvolved" type="checkbox" />
            My case involves military sexual trauma (MST)
          </label>
          <label>
            <input name="treatedInService" type="checkbox" />
            I was treated for this condition while in service
          </label>
          <label>
            <input name="hasVaRating" type="checkbox" />
            I have a VA disability rating for this condition
          </label>
          <button type="submit">Continue</button>
        </form>

        <p><Link href="/case">Back to case</Link></p>
      </main>
    )
  }

  const statuses = await getEvidenceStatuses(user.id, c.id)

  const recommended = recommendEvidence(ctx)
  const result = scoreCase(recommended, statuses)

  return (
    <main>
      <h1>Your evidence checklist</h1>
      {error && <p role="alert">{error}</p>}

      <p><strong>{result.score}/100</strong> — {result.band}</p>
      {result.topGap && (
        <p>
          Your highest-value next step: {result.topGap.label}. {result.topGap.guidance}
        </p>
      )}

      <ul>
        {recommended.map((item) => {
          const status = statuses[item.type] ?? 'needed'
          return (
            <li key={item.type}>
              <p><strong>{item.label}</strong></p>
              <p>{item.guidance}</p>
              <form action={setItemStatus}>
                <input type="hidden" name="itemType" value={item.type} />
                <label>
                  Status
                  <select name="status" defaultValue={status}>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{evidenceStatusLabel(s)}</option>
                    ))}
                  </select>
                </label>
                <button type="submit">Save</button>
              </form>
            </li>
          )
        })}
      </ul>

      <p>
        Why these items? This checklist and score measure completeness of your evidence —
        they do not predict any board&apos;s decision.
      </p>

      <CoachingSection />

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
