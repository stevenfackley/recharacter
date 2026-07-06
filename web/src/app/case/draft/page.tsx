import Link from 'next/link'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getCaseContext } from '@/lib/context'
import { getNexusAnswers, answersComplete } from '@/lib/nexus'
import { getDraft } from '@/lib/drafts'
import { saveDraft, generateStatement, generateCoverLetter } from './actions'

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)
  const answers = await getNexusAnswers(c.id)
  const ctx = await getCaseContext(c.id)

  const factsConfirmed = facts?.confirmed ?? false
  const nexusComplete = answers ? answersComplete(answers) : false

  const statement = await getDraft(c.id, 'personal_statement')
  const coverLetter = await getDraft(c.id, 'cover_letter')

  const canGenerateStatement = factsConfirmed && nexusComplete
  const canGenerateCoverLetter = factsConfirmed && ctx !== null

  return (
    <main>
      <h1>Your drafts</h1>
      {params.error && <p role="alert">{params.error}</p>}
      <p>
        These are drafts you own. Read every word; change anything that isn&apos;t right.
        Nothing is filed until you file it.
      </p>

      <section>
        <h2>Personal statement</h2>
        {!factsConfirmed && (
          <p>Confirm your <Link href="/case/intake">service facts</Link> first.</p>
        )}
        {factsConfirmed && !nexusComplete && (
          <p>Answer all four <Link href="/case/nexus">Kurta questions</Link> first.</p>
        )}

        {statement ? (
          <>
            <form action={saveDraft}>
              <input type="hidden" name="kind" value="personal_statement" />
              <textarea name="content" defaultValue={statement.content} rows={20} />
              <button type="submit">Save edits</button>
            </form>
            <p>
              Generated {new Date(statement.generated_at).toLocaleString()}
              {statement.edited && ', edited since'}.
            </p>
            {canGenerateStatement && (
              <form action={generateStatement}>
                {statement.edited && (
                  <label>
                    <input type="checkbox" name="confirm" />
                    I understand this will overwrite my edits
                  </label>
                )}
                <button type="submit">Generate again</button>
              </form>
            )}
            {params.confirm === 'statement' && (
              <p role="alert">Check the box above to overwrite your edited draft, then generate again.</p>
            )}
          </>
        ) : (
          canGenerateStatement && (
            <>
              <p>
                We&apos;ll assemble your statement from your four answers, confirmed facts, and
                collected evidence.
              </p>
              <form action={generateStatement}>
                <button type="submit">Generate</button>
              </form>
            </>
          )
        )}
      </section>

      <section>
        <h2>Cover letter</h2>
        <p>Needs confirmed service facts and the routing service, to address the right board and form.</p>
        {!factsConfirmed && (
          <p>Confirm your <Link href="/case/intake">service facts</Link> first.</p>
        )}
        {factsConfirmed && !ctx && (
          <p>Complete your <Link href="/case/evidence">case details</Link> first.</p>
        )}

        {coverLetter ? (
          <>
            <form action={saveDraft}>
              <input type="hidden" name="kind" value="cover_letter" />
              <textarea name="content" defaultValue={coverLetter.content} rows={16} />
              <button type="submit">Save edits</button>
            </form>
            <p>
              Generated {new Date(coverLetter.generated_at).toLocaleString()}
              {coverLetter.edited && ', edited since'}.
            </p>
            {canGenerateCoverLetter && (
              <form action={generateCoverLetter}>
                {coverLetter.edited && (
                  <label>
                    <input type="checkbox" name="confirm" />
                    I understand this will overwrite my edits
                  </label>
                )}
                <button type="submit">Generate again</button>
              </form>
            )}
            {params.confirm === 'cover_letter' && (
              <p role="alert">Check the box above to overwrite your edited draft, then generate again.</p>
            )}
          </>
        ) : (
          canGenerateCoverLetter && (
            <form action={generateCoverLetter}>
              <button type="submit">Generate</button>
            </form>
          )
        )}
      </section>

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
