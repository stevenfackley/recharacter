import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { nexusAnswers } from '@/db/schema'
import { assertCaseOwned } from '@/lib/cases'

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

export async function getNexusAnswers(ownerId: string, caseId: string): Promise<NexusAnswers | null> {
  const [row] = await getDb()
    .select()
    .from(nexusAnswers)
    .where(and(eq(nexusAnswers.caseId, caseId), eq(nexusAnswers.ownerId, ownerId)))
    .limit(1)
  if (!row) return null
  return {
    q1_condition: row.q1Condition,
    q2_during_service: row.q2DuringService,
    q3_mitigation: row.q3Mitigation,
    q4_outweigh: row.q4Outweigh,
  }
}

/** The four answers are stored one column each — the question key picks the column. */
const ANSWER_COLUMNS = {
  q1: 'q1Condition',
  q2: 'q2DuringService',
  q3: 'q3Mitigation',
  q4: 'q4Outweigh',
} as const satisfies Record<KurtaKey, keyof typeof nexusAnswers.$inferInsert>

/**
 * Saves ONE answer. The `set` clause names only that answer's column: a
 * whole-object set would write the three untouched columns back as their
 * insert defaults (empty strings) and silently wipe the other answers.
 */
export async function saveNexusAnswer(
  ownerId: string,
  caseId: string,
  key: KurtaKey,
  text: string,
): Promise<void> {
  await assertCaseOwned(ownerId, caseId)
  const column = ANSWER_COLUMNS[key]
  const rows = await getDb()
    .insert(nexusAnswers)
    .values({ caseId, ownerId, [column]: text })
    .onConflictDoUpdate({
      target: nexusAnswers.caseId,
      set: { [column]: text, updatedAt: new Date() },
      setWhere: eq(nexusAnswers.ownerId, ownerId),
    })
    .returning({ id: nexusAnswers.id })
  // A no-op conflict branch means the row belongs to another owner; losing an
  // answer the veteran just typed must never pass for a save.
  if (!rows.length) throw new Error('nexus_answers write affected no rows (owner mismatch)')
}
