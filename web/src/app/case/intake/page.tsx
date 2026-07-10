import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts, BRANCHES, CHARACTERIZATIONS } from '@/lib/facts'
import type { Metadata } from 'next'
import { branchLabel, characterizationLabel } from '@/lib/labels'
import { uploadAndExtract, confirmFacts } from './actions'
import { UploadField } from './upload-field'

export const metadata: Metadata = { title: 'Your service facts' }

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)

  // Prefill comes ONLY from the database (unconfirmed extracted rows included) —
  // never from query params, which must stay free of personal data.
  const prefill = {
    branch: facts?.branch ?? '',
    dischargeDate: facts?.dischargeDate ?? '',
    characterization: facts?.characterization ?? '',
    wasGeneralCourtMartial: facts?.wasGeneralCourtMartial ?? false,
  }

  return (
    <main>
      <h1>Your service facts</h1>
      {params.error && <p role="alert">{params.error}</p>}
      {params.extracted && (
        <p role="status">
          We read your document. Review every field below — you confirm what is correct.
        </p>
      )}
      {params.partial && (
        <p role="status">
          We could read some of your document. Fill in the rest below.
        </p>
      )}

      <section>
        <h2>Upload your DD-214 (or similar separation document)</h2>
        <form action={uploadAndExtract}>
          <UploadField />
          <button type="submit">Upload and read</button>
        </form>
        <p>PDF or photo, 15 MB max. Stored privately; only you can access it.</p>
      </section>

      <section>
        <h2>Or enter the facts yourself</h2>
        <form action={confirmFacts}>
          <label>
            Branch
            <select name="branch" defaultValue={prefill.branch} required>
              <option value="" disabled>Select…</option>
              {BRANCHES.map((b) => <option key={b} value={b}>{branchLabel(b)}</option>)}
            </select>
          </label>
          <label>
            Discharge date
            <input name="dischargeDate" type="date" defaultValue={prefill.dischargeDate} required />
          </label>
          <label>
            Characterization of service
            <select name="characterization" defaultValue={prefill.characterization} required>
              <option value="" disabled>Select…</option>
              {CHARACTERIZATIONS.map((ch) => (
                <option key={ch} value={ch}>{characterizationLabel(ch)}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              name="wasGeneralCourtMartial" type="checkbox"
              defaultChecked={prefill.wasGeneralCourtMartial}
            />
            My discharge resulted from a general court-martial
          </label>
          <button type="submit">Confirm these facts</button>
        </form>
      </section>
    </main>
  )
}
