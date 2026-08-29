'use server'

import { refresh } from 'next/cache'
import { getSessionUser, requireSessionUser } from '@/lib/session'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { KURTA_QUESTIONS, saveNexusAnswer } from '@/lib/nexus'

// Must match the drafting task's per-answer cap (draftAnswers .max(6000) in
// tasks.ts) — a longer answer would save fine and then permanently fail statement
// generation with a misleading "try again" error.
const MAX_ANSWER_LENGTH = 6000

export type SaveState = { saved: boolean; error: string | null }

/**
 * The human-owned save path: whatever text is in the textarea when Save is
 * pressed. Returns state rendered inline by the question component rather than
 * redirecting — a full-page transition here discards unsaved text in the other
 * three textareas (issue #9). refresh() re-renders the server components (the
 * answered-count) while client textarea state survives.
 *
 * Failures are inline copy rather than an `?error=` code for the same reason:
 * this action deliberately never reaches a URL.
 */
export async function saveAnswer(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const user = await requireSessionUser('/case/nexus')

  const key = String(formData.get('questionKey') ?? '')
  const question = KURTA_QUESTIONS.find((q) => q.key === key)
  if (!question) return { saved: false, error: 'Unknown question' }

  const text = String(formData.get('text') ?? '')
  if (text.length > MAX_ANSWER_LENGTH) {
    return { saved: false, error: 'Answer too long (6000 characters max)' }
  }

  const c = await getOrCreateCase(user.id)
  try {
    await saveNexusAnswer(user.id, c.id, question.key, text)
  } catch (err) {
    // The failure message only — the answer itself never goes to a log.
    console.error('nexus answer save failed:', err instanceof Error ? err.message : err)
    return { saved: false, error: 'Could not save — try again shortly' }
  }
  refresh()
  return { saved: true, error: null }
}

export type ShapeState = { shapedAnswer: string | null; gaps: string | null }

/**
 * Why a refused shaping returns state instead of redirecting: the four answers
 * live in four client textareas, and a navigation away from this page throws
 * away every unsaved word in the other three (issue #9). A veteran who presses
 * "Help me phrase this" without the unlock gets told so in place, with the
 * upgrade page named, and their typing survives.
 */
const PAYMENT_REQUIRED_NOTE =
  'Phrasing help needs the case unlock or your own API key — see /case/upgrade. ' +
  'Your answers here are untouched.'

const AI_UNAVAILABLE_NOTE =
  'Phrasing help is unavailable right now. Your answers here are untouched.'

/**
 * Optional AI phrasing help. Returns the PROPOSAL as the action result — rendered
 * into the textarea client-side by a small per-question client component and
 * NEVER written to the database or a URL until the veteran presses Save. This
 * keeps AI-generated text out of query strings (which land in server logs,
 * browser history, and Referer headers — the same rule the intake and coaching
 * flows enforce). questionPrompt is resolved here from KURTA_QUESTIONS by key;
 * a client-supplied prompt is never trusted.
 */
export async function shapeAnswer(_prev: ShapeState, formData: FormData): Promise<ShapeState> {
  const user = await getSessionUser()
  if (!user) return { shapedAnswer: null, gaps: null }

  const key = String(formData.get('questionKey') ?? '')
  const question = KURTA_QUESTIONS.find((q) => q.key === key)
  if (!question) return { shapedAnswer: null, gaps: null }

  const rawNarrative = String(formData.get('text') ?? '').trim()
  if (!rawNarrative) return { shapedAnswer: null, gaps: null }

  let result
  try {
    result = await executeAiTask(user.id, 'shape_nexus_answer', {
      questionKey: question.key,
      questionPrompt: question.prompt,
      rawNarrative,
    })
  } catch (err) {
    // The gateway can reject outright (an attempt it could not record). Inline
    // state, never a 500 that would take the other three answers with it.
    console.error('shape_nexus_answer failed:', err instanceof Error ? err.message : err)
    return { shapedAnswer: null, gaps: AI_UNAVAILABLE_NOTE }
  }
  if (!result.ok) {
    if (result.status === 402) return { shapedAnswer: null, gaps: PAYMENT_REQUIRED_NOTE }
    return { shapedAnswer: null, gaps: AI_UNAVAILABLE_NOTE }
  }

  const d = result.data as { shapedAnswer: string; gaps: string }
  return { shapedAnswer: d.shapedAnswer, gaps: d.gaps || null }
}
