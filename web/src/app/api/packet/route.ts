import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { routeDischarge } from '@/lib/routing'
import { getDraft } from '@/lib/drafts'
import { getEvidenceStatuses } from '@/lib/evidence-items'
import { isEntitled } from '@/lib/billing'
import { EVIDENCE_CATALOG, type EvidenceType } from '@/lib/evidence'
import { buildPacketSections, type PacketInput } from '@/lib/packet/sections'
import { renderPacket } from '@/lib/packet/render'

/**
 * On-demand packet download — no storage, generated fresh every request. Route
 * is the impure shell: it's the only place `generatedOn` is computed from the
 * clock and the only place I/O happens. Section/worksheet builders stay pure.
 *
 * Every response carries no-store + Vary: Cookie. The body is the veteran's own
 * petition, and a shared cache keyed without the session cookie is the one way
 * one veteran's packet reaches another's browser.
 */
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

export async function GET() {
  const user = await getSessionUser()
  if (!user) return json({ error: 'unauthenticated' }, 401)

  if (!(await isEntitled(user.id))) {
    return json(
      { error: 'Downloading your packet needs the case unlock or your own API key', upgrade: '/case/upgrade' },
      402,
    )
  }

  const c = await getOrCreateCase(user.id)

  const facts = await getServiceFacts(user.id, c.id)
  if (!facts || !facts.confirmed) {
    return json({ error: 'Confirm your service facts before downloading your packet' }, 409)
  }

  let routing
  try {
    routing = await routeDischarge({
      branch: facts.branch,
      dischargeDate: facts.dischargeDate,
      characterization: facts.characterization,
      wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
    })
  } catch {
    return json({ error: 'The routing service is unavailable right now — try again shortly' }, 503)
  }

  const statementDraft = await getDraft(user.id, c.id, 'personal_statement')
  if (!statementDraft) {
    return json({ error: 'Generate your personal statement before downloading your packet' }, 409)
  }
  const coverLetterDraft = await getDraft(user.id, c.id, 'cover_letter')

  const statuses = await getEvidenceStatuses(user.id, c.id)
  const evidence: Array<{ label: string; status: string }> = Object.entries(statuses)
    .map(([itemType, status]) => {
      const catalogEntry = EVIDENCE_CATALOG[itemType as EvidenceType]
      return catalogEntry ? { label: catalogEntry.label, status: status as string } : null
    })
    .filter((e): e is { label: string; status: string } => e !== null)

  const input: PacketInput = {
    generatedOn: new Date().toISOString().slice(0, 10),
    facts: {
      branch: facts.branch,
      dischargeDate: facts.dischargeDate,
      characterization: facts.characterization,
      wasGeneralCourtMartial: facts.wasGeneralCourtMartial,
    },
    routing: {
      boardName: routing.boardName,
      recommendedForm: routing.recommendedForm,
      drbDeadline: routing.drbDeadline,
      drbWindowOpen: routing.drbWindowOpen,
    },
    statement: statementDraft.content,
    coverLetter: coverLetterDraft?.content ?? null,
    evidence,
  }

  let bytes: Uint8Array
  try {
    const sections = buildPacketSections(input)
    bytes = await renderPacket(sections, { title: `Recharacter Packet — ${input.generatedOn}` })
  } catch (err) {
    // Never log user content (statement/cover-letter text) — only the
    // underlying error message pdf-lib (or the section builder) produced.
    console.error('packet render failed:', err instanceof Error ? err.message : err)
    return json({ error: 'packet_render_failed' }, 500)
  }

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="recharacter-packet.pdf"',
    },
  })
}
