import type { Metadata } from 'next'
import Link from 'next/link'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getNexusAnswers, KURTA_QUESTIONS, answersComplete } from '@/lib/nexus'
import { NexusQuestion } from './question'

export const metadata: Metadata = { title: 'The four questions' }

export default async function NexusPage() {
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)
  const answers = await getNexusAnswers(c.id)

  const filledCount = KURTA_QUESTIONS.filter(
    (q) => (answers?.[q.column] ?? '').trim().length > 0,
  ).length
  const complete = answersComplete(answers ?? {
    q1_condition: '', q2_during_service: '', q3_mitigation: '', q4_outweigh: '',
  })

  return (
    <main>
      <h1>The four questions</h1>
      {!facts?.confirmed && (
        <p role="alert">
          Confirm your service facts before generating a draft.{' '}
          <Link href="/case/intake">Go to intake</Link>
        </p>
      )}

      <p>{filledCount} of 4 answered</p>

      {KURTA_QUESTIONS.map((q) => (
        <NexusQuestion
          key={q.key}
          qKey={q.key}
          prompt={q.prompt}
          explainer={q.explainer}
          initialText={answers?.[q.column] ?? ''}
        />
      ))}

      {complete && (
        <p><Link href="/case/draft">Continue to your draft statement</Link></p>
      )}

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
