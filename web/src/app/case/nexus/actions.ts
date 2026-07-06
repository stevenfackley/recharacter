'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { KURTA_QUESTIONS, saveNexusAnswer } from '@/lib/nexus'

const MAX_ANSWER_LENGTH = 8000

/** The human-owned save path: whatever text is in the textarea when Save is pressed. */
export async function saveAnswer(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const key = String(formData.get('questionKey') ?? '')
  const question = KURTA_QUESTIONS.find((q) => q.key === key)
  if (!question) redirect('/case/nexus')

  const text = String(formData.get('text') ?? '')
  if (text.length > MAX_ANSWER_LENGTH) {
    redirect('/case/nexus?error=' + encodeURIComponent('Answer too long (8000 characters max)'))
  }

  const c = await getOrCreateCase()
  await saveNexusAnswer(c.id, question.column, text)
  redirect('/case/nexus?saved=' + encodeURIComponent(question.key))
}

export type ShapeState = { shapedAnswer: string | null; gaps: string | null }

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { shapedAnswer: null, gaps: null }

  const key = String(formData.get('questionKey') ?? '')
  const question = KURTA_QUESTIONS.find((q) => q.key === key)
  if (!question) return { shapedAnswer: null, gaps: null }

  const rawNarrative = String(formData.get('text') ?? '').trim()
  if (!rawNarrative) return { shapedAnswer: null, gaps: null }

  const result = await executeAiTask(supabase, user.id, 'shape_nexus_answer', {
    questionKey: question.key,
    questionPrompt: question.prompt,
    rawNarrative,
  })
  if (!result.ok) return { shapedAnswer: null, gaps: null }

  const d = result.data as { shapedAnswer: string; gaps: string }
  return { shapedAnswer: d.shapedAnswer, gaps: d.gaps || null }
}
