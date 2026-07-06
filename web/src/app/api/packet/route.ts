import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateCase } from '@/lib/cases'
import { getServiceFacts } from '@/lib/facts'
import { routeDischarge } from '@/lib/routing'
import { getDraft } from '@/lib/drafts'
import { isEntitled } from '@/lib/billing'
import { EVIDENCE_CATALOG, type EvidenceType } from '@/lib/evidence'
import { buildPacketSections, type PacketInput } from '@/lib/packet/sections'
import { renderPacket } from '@/lib/packet/render'

/**
 * On-demand packet download — no storage, generated fresh every request. Route
 * is the impure shell: it's the only place `generatedOn` is computed from the
 * clock and the only place I/O happens. Section/worksheet builders stay pure.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (!(await isEntitled(supabase, user.id))) {
    return NextResponse.json(
      { error: 'Downloading your packet needs the case unlock or your own API key', upgrade: '/case/upgrade' },
      { status: 402 },
    )
  }

  const c = await getOrCreateCase()

  const facts = await getServiceFacts(c.id)
  if (!facts || !facts.confirmed) {
    return NextResponse.json(
      { error: 'Confirm your service facts before downloading your packet' },
      { status: 409 },
    )
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
    return NextResponse.json(
      { error: 'The routing service is unavailable right now — try again shortly' },
      { status: 503 },
    )
  }

  const statementDraft = await getDraft(c.id, 'personal_statement')
  if (!statementDraft) {
    return NextResponse.json(
      { error: 'Generate your personal statement before downloading your packet' },
      { status: 409 },
    )
  }
  const coverLetterDraft = await getDraft(c.id, 'cover_letter')

  const { data: itemRows } = await supabase
    .from('evidence_items').select('item_type, status').eq('case_id', c.id)
  const evidence: Array<{ label: string; status: string }> = (itemRows ?? [])
    .map((r) => {
      const catalogEntry = EVIDENCE_CATALOG[r.item_type as EvidenceType]
      return catalogEntry ? { label: catalogEntry.label, status: r.status as string } : null
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

  const sections = buildPacketSections(input)
  const bytes = await renderPacket(sections, { title: `Recharacter Packet — ${input.generatedOn}` })

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="recharacter-packet.pdf"',
    },
  })
}
