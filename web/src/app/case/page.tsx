import Link from 'next/link'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { routeDischarge, type RoutingResult } from '@/lib/routing'

const LATER_STEPS = ['Evidence', 'Nexus', 'Draft', 'Coaching', 'Packet'] as const

const FLAG_TEXT: Record<string, string> = {
  PastDrbWindow: 'The 15-year Discharge Review Board window has closed for this discharge.',
  GeneralCourtMartialRequiresBcmr:
    'Discharges from a general court-martial can only be reviewed by the correction board.',
  CoastGuardDhsPolicyDiffers:
    'Coast Guard boards operate under DHS; policies are similar to DoD but not identical.',
  BcmrThreeYearStatuteWaiverLikely:
    'The correction board has a 3-year filing rule, but it is routinely waived in the interest of justice.',
  EntryLevelSeparationUncharacterized:
    'An uncharacterized (entry-level) separation is not a derogatory characterization; boards can still change it.',
  AlreadyHonorableNothingToUpgrade:
    'This service is already characterized as Honorable — there is no characterization to upgrade.',
}

export default async function CasePage() {
  const c = await getOrCreateCase()
  const facts = await getServiceFacts(c.id)

  let routing: RoutingResult | null = null
  let routingError = false
  if (facts?.confirmed) {
    try {
      routing = await routeDischarge({
        branch: facts.branch,
        dischargeDate: facts.dischargeDate,
        characterization: facts.characterization,
        wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
      })
    } catch {
      routingError = true
    }
  }

  return (
    <main>
      <h1>Your discharge-upgrade case</h1>

      <section>
        <h2>1. Service facts</h2>
        {facts?.confirmed ? (
          <p>
            {facts.branch}, discharged {facts.dischargeDate} ({facts.characterization}).{' '}
            <Link href="/case/intake">Edit</Link>
          </p>
        ) : (
          <p>
            <Link href="/case/intake">
              {facts ? 'Review and confirm your facts' : 'Start here: add your service facts'}
            </Link>
          </p>
        )}
      </section>

      <section>
        <h2>2. Where your case goes</h2>
        {!facts?.confirmed && <p>Confirm your service facts first.</p>}
        {routingError && <p role="alert">The routing service is unavailable right now — try again shortly.</p>}
        {routing && (
          <>
            <p>
              <strong>{routing.boardName}</strong> — file{' '}
              <strong>{routing.recommendedForm === 'DD293' ? 'DD Form 293' : 'DD Form 149'}</strong>
            </p>
            <p>
              {routing.drbWindowOpen
                ? `The Discharge Review Board window is open until ${routing.drbDeadline}.`
                : 'The 15-year Discharge Review Board window has closed; the correction board is the path.'}
            </p>
            {routing.flags.length > 0 && (
              <ul>
                {routing.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}
              </ul>
            )}
            <p>
              This is the computed filing route for the facts you confirmed — it is process
              information, not legal advice.
            </p>
          </>
        )}
      </section>

      <ol start={3}>
        {LATER_STEPS.map((step) => <li key={step}>{step} — not started</li>)}
      </ol>

      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
