import Link from 'next/link'
import type { Metadata } from 'next'
import { deleteAccount } from './actions'

export const metadata: Metadata = { title: 'Your data' }

export default async function DataSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <h1>Your data</h1>
      {error && <p role="alert">{error}</p>}
      <p>
        Everything ReCharacter holds exists for one purpose: assembling your
        petition. Both controls below cover all of it — your case, service
        facts, answers, drafts, uploaded records, and usage history.
      </p>

      <section>
        <h2>Export everything</h2>
        <p>
          One file, machine-readable JSON, containing every record tied to your
          account. Your uploaded documents are listed by name — the files
          themselves are the copies you uploaded and remain downloadable from
          your case until you delete them.
        </p>
        <p>
          <a href="/api/account/export" download>Download my data</a>
        </p>
      </section>

      <section>
        <h2>Delete your account</h2>
        <p>
          Permanent and immediate: your account, case, answers, drafts,
          uploaded documents, and usage records are all removed. There is no
          recovery. If you want a copy, export first.
        </p>
        <form action={deleteAccount}>
          <label>
            <input name="confirm" type="checkbox" />
            I understand this permanently deletes my account and everything in it
          </label>
          <button type="submit">Delete my account</button>
        </form>
      </section>

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
