import Link from 'next/link'
import type { Metadata } from 'next'
import { requireSessionUser } from '@/lib/session'
import { deleteAccount } from './actions'

export const metadata: Metadata = { title: 'Your data' }

/**
 * The closed set of failures this page will name. `?error=` is rendered back
 * onto recharacter.us, and attacker-chosen copy on a page whose users are
 * already being asked for stigmatizing records is a phishing surface — so only
 * these codes resolve to words, never `error` itself (see lib/auth-errors.ts).
 */
const ERRORS = {
  confirm_phrase: 'Tick the confirmation box to delete your account.',
  deletion_unavailable: 'Account deletion is temporarily unavailable. Nothing was removed.',
  deletion_failed: 'Deletion did not complete. Nothing was removed — try again shortly.',
} as const

export default async function DataSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  // The proxy is a redirect convenience, not the gate: this page names the two
  // controls that empty an account, so it proves the session itself.
  await requireSessionUser('/settings/data')
  const { error } = await searchParams
  const message = ERRORS[error as keyof typeof ERRORS] ?? null

  return (
    <main>
      <h1>Your data</h1>
      {message && <p role="alert">{message}</p>}
      <p>
        Everything ReCharacter holds exists for one purpose: assembling your
        petition. Both controls below cover all of it — your case, service
        facts, answers, drafts, uploaded records, and usage history.
      </p>

      <section>
        <h2>Export everything</h2>
        <p>
          One file, machine-readable JSON, containing every record tied to your
          account. Documents you upload are kept only to run extraction on them;
          the export lists their file names, and deleting your account removes
          the files themselves.
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
