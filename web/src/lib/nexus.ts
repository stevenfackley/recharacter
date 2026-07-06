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
