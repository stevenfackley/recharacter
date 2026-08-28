import Link from 'next/link'
import type { Metadata } from 'next'
import { requireSessionUser } from '@/lib/session'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getCaseContext } from '@/lib/context'
import { getNexusAnswers, answersComplete } from '@/lib/nexus'
import { getDraft } from '@/lib/drafts'
import { saveDraft, generateStatement, generateCoverLetter } from './actions'

export const metadata: Metadata = { title: 'Your drafts' }

/**
 * The closed set of failures this page will name. Only these codes resolve to
 * copy — `params.error` is never rendered. A rejected BYOK key is deliberately
 * its own code: a retry can never fix it, so its copy must not offer one.
 */
const ERRORS = {
  save_failed: 'Could not save your draft — try again shortly.',
  generate_failed: 'Could not generate that right now — try again shortly.',
  byok_key_rejected:
    'Your AI provider rejected your API key — check it in AI settings, then generate again.',
  byok_key_unreadable:
    'Your saved API key could not be read, so it was never sent anywhere — re-enter it in ' +
    'AI settings, then generate again.',
  rate_limited: 'Too many AI requests just now — wait a minute, then generate again.',
  ai_unavailable:
    'AI drafting is temporarily unavailable on our side — you can write this document ' +
    'directly below in the meantime.',
  routing_unavailable: 'The routing service is unavailable right now — try again shortly.',
  draft_too_long: 'Draft too long (50,000 characters max).',
} as const

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const user = await requireSessionUser('/case/draft')
  const c = await getOrCreateCase(user.id)
  const facts = await getServiceFacts(user.id, c.id)
  const answers = await getNexusAnswers(user.id, c.id)
  const ctx = await getCaseContext(user.id, c.id)

  const error = ERRORS[params.error as keyof typeof ERRORS] ?? null
  const factsConfirmed = facts?.confirmed ?? false
  const nexusComplete = answers ? answersComplete(answers) : false

  const statement = await getDraft(user.id, c.id, 'personal_statement')
  const coverLetter = await getDraft(user.id, c.id, 'cover_letter')

  const canGenerateStatement = factsConfirmed && nexusComplete
  const canGenerateCoverLetter = factsConfirmed && ctx !== null

  return (
    <main>
      <h1>Your drafts</h1>
      {error && <p role="alert">{error}</p>}
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
