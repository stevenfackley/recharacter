import Link from 'next/link'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { getDraft } from '@/lib/drafts'
import { isEntitled } from '@/lib/billing'
import { createClient } from '@/lib/supabase/server'

export default async function PacketPage() {
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)
  const factsConfirmed = facts?.confirmed ?? false

  const statement = await getDraft(c.id, 'personal_statement')
  const coverLetter = await getDraft(c.id, 'cover_letter')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const entitled = user ? await isEntitled(supabase, user.id) : false

  const { data: itemRows } = await supabase
    .from('evidence_items').select('item_type, status').eq('case_id', c.id)
  const evidenceCount = (itemRows ?? []).filter((r) => r.status === 'collected').length

  // Mirrors the route's gates exactly: confirmed facts + a personal-statement
  // draft are required. Cover letter and evidence are included when present.
  const ready = factsConfirmed && Boolean(statement) && entitled

  return (
    <main>
      <h1>Your filing packet</h1>
      <p>
        One PDF with everything you need to file: your cover letter (when drafted), your
        personal statement, an evidence index, and a worksheet mapping every answer to the
        official form&apos;s item numbers.
      </p>

      <ul>
        <li>
          {factsConfirmed ? '✓' : '✗'} Service facts confirmed
          {!factsConfirmed && <> — <Link href="/case/intake">confirm your facts</Link></>}
        </li>
        <li>
          {statement ? '✓' : '✗'} Personal statement drafted
          {!statement && <> — <Link href="/case/draft">draft your statement</Link></>}
        </li>
        <li>{coverLetter ? '✓' : '—'} Cover letter (optional)</li>
        <li>{evidenceCount} evidence item{evidenceCount === 1 ? '' : 's'} collected</li>
        <li>
          {entitled ? '✓' : '✗'} Case unlocked
          {!entitled && <> — <Link href="/case/upgrade">unlock with a one-time payment or your own API key</Link></>}
        </li>
      </ul>

      {ready ? (
        <p><a href="/api/packet">Download your packet (PDF)</a></p>
      ) : !entitled && factsConfirmed && statement ? (
        <p><Link href="/case/upgrade">Unlock your download</Link></p>
      ) : (
        <p>Complete the required items above to unlock your download.</p>
      )}

      <section>
        <h2>Filing the official form</h2>
        <p>
          Get the official form from{' '}
          <a href="https://www.esd.whs.mil/Directives/forms/" target="_blank" rel="noreferrer">
            esd.whs.mil (DoD Forms)
          </a>
          . It opens as a fillable PDF — fill it out item by item using the Form Worksheet in
          your packet, then print, sign, and date it by hand.
        </p>
        <p>
          This packet is document assembly, not legal advice. You decide what to file, and you
          file it yourself.
        </p>
      </section>

      <p><Link href="/case">Back to case</Link></p>
    </main>
  )
}
