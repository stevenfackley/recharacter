import { buildWorksheet } from './worksheet'

export type PacketLine =
  | { kind: 'heading'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'body'; text: string }
  | { kind: 'item'; label: string; value: string }
  | { kind: 'spacer' }

export type PacketSection = { title: string; startOnNewPage: boolean; lines: PacketLine[] }

export type PacketInput = {
  generatedOn: string // ISO date, injected (no Date.now inside builders)
  facts: { branch: string; dischargeDate: string; characterization: string; wasGeneralCourtMartial: boolean }
  routing: { boardName: string; recommendedForm: 'DD293' | 'DD149'; drbDeadline: string; drbWindowOpen: boolean }
  statement: string
  coverLetter: string | null
  evidence: Array<{ label: string; status: string }>
}

const FORM_NAMES: Record<'DD293' | 'DD149', string> = {
  DD293: 'DD Form 293',
  DD149: 'DD Form 149',
}

// Item number of the signature block — same position on both forms' row tables (worksheet.ts).
const SIGNATURE_ITEM = '11'

function paragraphLines(text: string): PacketLine[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ kind: 'body', text: p }))
}

function buildCoverLetterSection(coverLetter: string | null): PacketSection | null {
  if (!coverLetter) return null
  return {
    title: 'Cover Letter',
    startOnNewPage: true,
    lines: [
      { kind: 'heading', text: 'Cover Letter' },
      { kind: 'spacer' },
      ...paragraphLines(coverLetter),
    ],
  }
}

function buildStatementSection(statement: string): PacketSection {
  return {
    title: 'Personal Statement',
    startOnNewPage: true,
    lines: [
      { kind: 'heading', text: 'Personal Statement' },
      { kind: 'spacer' },
      ...paragraphLines(statement),
    ],
  }
}

function buildEvidenceIndexSection(evidence: Array<{ label: string; status: string }>): PacketSection {
  const lines: PacketLine[] = [
    { kind: 'heading', text: 'Evidence Index' },
    { kind: 'spacer' },
  ]
  if (evidence.length === 0) {
    lines.push({ kind: 'body', text: 'None listed yet.' })
  } else {
    for (const item of evidence) lines.push({ kind: 'item', label: item.label, value: item.status })
  }
  return { title: 'Evidence Index', startOnNewPage: true, lines }
}

function buildWorksheetSection(input: PacketInput): PacketSection {
  const formName = FORM_NAMES[input.routing.recommendedForm]
  const title = `Form Worksheet (${formName})`
  const rows = buildWorksheet(input)
  return {
    title,
    startOnNewPage: true,
    lines: [
      { kind: 'heading', text: title },
      { kind: 'spacer' },
      { kind: 'body', text: `Use this worksheet to fill out the official ${formName} item by item.` },
      { kind: 'spacer' },
      ...rows.map((r): PacketLine => ({ kind: 'item', label: r.item, value: r.value })),
    ],
  }
}

function buildHowToFileSection(input: PacketInput): PacketSection {
  const formName = FORM_NAMES[input.routing.recommendedForm]
  const lines: PacketLine[] = [
    { kind: 'heading', text: 'How to File' },
    { kind: 'spacer' },
    { kind: 'body', text: `Download the official ${formName} from esd.whs.mil (DoD Forms). It opens as a fillable PDF.` },
    {
      kind: 'body',
      text: 'Fill it item by item using the Form Worksheet in this packet. Where the worksheet says ' +
        'SEE ATTACHED STATEMENT, write exactly that.',
    },
    {
      kind: 'body',
      text: `Print, sign, and date the form by hand (Item ${SIGNATURE_ITEM}). Unsigned applications are returned.`,
    },
    {
      kind: 'body',
      text: 'Assemble: signed form on top, then your personal statement, then your evidence in the order ' +
        'of the Evidence Index.',
    },
    {
      kind: 'body',
      text: `Mail to ${input.routing.boardName} at the address in the form's instructions, or file online ` +
        'where your branch supports it.',
    },
  ]
  if (input.routing.drbWindowOpen) {
    lines.push({
      kind: 'body',
      text: `Your Discharge Review Board window is open until ${input.routing.drbDeadline}. File before that date.`,
    })
  }
  lines.push({
    kind: 'body',
    text: 'This packet is document assembly, not legal advice. You decide what to file, and you file it yourself.',
  })
  return { title: 'How to File', startOnNewPage: true, lines }
}

/** PURE: assembles every packet section from the given input. No I/O, no clock. */
export function buildPacketSections(input: PacketInput): PacketSection[] {
  const sections: PacketSection[] = []
  const coverLetterSection = buildCoverLetterSection(input.coverLetter)
  if (coverLetterSection) sections.push(coverLetterSection)
  sections.push(buildStatementSection(input.statement))
  sections.push(buildEvidenceIndexSection(input.evidence))
  sections.push(buildWorksheetSection(input))
  sections.push(buildHowToFileSection(input))
  return sections
}
