import { describe, expect, test } from 'vitest'
import { buildPacketSections } from '@/lib/packet/sections'
import type { PacketInput, PacketLine, PacketSection } from '@/lib/packet/sections'

const baseInput: PacketInput = {
  generatedOn: '2026-07-06',
  facts: {
    branch: 'MarineCorps',
    dischargeDate: '2015-04-01',
    characterization: 'OtherThanHonorable',
    wasGeneralCourtMartial: false,
  },
  routing: {
    boardName: 'NDRB',
    recommendedForm: 'DD293',
    drbDeadline: '2030-04-01',
    drbWindowOpen: true,
  },
  statement: 'First paragraph of the statement.\n\nSecond paragraph of the statement.',
  coverLetter: 'Dear Board,\n\nPlease review my case.',
  evidence: [
    { label: 'DD-214', status: 'collected' },
    { label: 'VA rating letter', status: 'needed' },
  ],
}

function bodyTexts(section: PacketSection): string[] {
  return section.lines
    .filter((l): l is Extract<PacketLine, { kind: 'body' }> => l.kind === 'body')
    .map((l) => l.text)
}

function allText(section: PacketSection): string {
  return section.lines
    .filter((l): l is Extract<PacketLine, { kind: 'body' | 'heading' | 'subheading' }> =>
      l.kind === 'body' || l.kind === 'heading' || l.kind === 'subheading')
    .map((l) => l.text)
    .join(' ')
}

describe('buildPacketSections', () => {
  test('produces sections titled exactly, in order, when a cover letter draft exists', () => {
    const sections = buildPacketSections(baseInput)
    expect(sections.map((s) => s.title)).toEqual([
      'Cover Letter',
      'Personal Statement',
      'Evidence Index',
      'Form Worksheet (DD Form 293)',
      'How to File',
    ])
  })

  test('omits the Cover Letter section when no cover-letter draft exists', () => {
    const sections = buildPacketSections({ ...baseInput, coverLetter: null })
    expect(sections.map((s) => s.title)).toEqual([
      'Personal Statement',
      'Evidence Index',
      'Form Worksheet (DD Form 293)',
      'How to File',
    ])
  })

  test('titles the worksheet section for DD Form 149 when routing recommends it', () => {
    const sections = buildPacketSections({
      ...baseInput,
      routing: { ...baseInput.routing, recommendedForm: 'DD149' },
    })
    expect(sections.map((s) => s.title)).toContain('Form Worksheet (DD Form 149)')
  })

  test('statement body lines preserve paragraph breaks', () => {
    const sections = buildPacketSections(baseInput)
    const statementSection = sections.find((s) => s.title === 'Personal Statement')!
    const texts = bodyTexts(statementSection)
    expect(texts).toContain('First paragraph of the statement.')
    expect(texts).toContain('Second paragraph of the statement.')
    expect(texts.length).toBeGreaterThanOrEqual(2)
  })

  test('evidence index renders label+status items when present, and a "none listed yet" line when empty', () => {
    const withEvidence = buildPacketSections(baseInput)
      .find((s) => s.title === 'Evidence Index')!
    const items = withEvidence.lines.filter(
      (l): l is Extract<PacketLine, { kind: 'item' }> => l.kind === 'item',
    )
    expect(items).toEqual([
      { kind: 'item', label: 'DD-214', value: 'collected' },
      { kind: 'item', label: 'VA rating letter', value: 'needed' },
    ])

    const empty = buildPacketSections({ ...baseInput, evidence: [] })
      .find((s) => s.title === 'Evidence Index')!
    expect(bodyTexts(empty).some((t) => /none listed yet/i.test(t))).toBe(true)
  })

  test('How to File names the official form, the board, and the deadline when the DRB window is open; omits the deadline line when closed', () => {
    const open = buildPacketSections(baseInput).find((s) => s.title === 'How to File')!
    const openText = allText(open)
    expect(openText).toContain('DD Form 293')
    expect(openText).toContain('NDRB')
    expect(openText).toContain('2030-04-01')
    expect(openText).toContain('you file it yourself')

    const closed = buildPacketSections({
      ...baseInput,
      routing: { ...baseInput.routing, drbWindowOpen: false },
    }).find((s) => s.title === 'How to File')!
    expect(allText(closed)).not.toContain('Discharge Review Board window is open')
  })

  test('the disclaimer sentence appears verbatim in How to File, and "legal advice" appears nowhere else', () => {
    const sections = buildPacketSections(baseInput)
    const disclaimer =
      'This packet is document assembly, not legal advice. You decide what to file, and you file it yourself.'

    const withDisclaimer = sections.filter((s) =>
      s.lines.some((l) => 'text' in l && l.text === disclaimer),
    )
    expect(withDisclaimer.map((s) => s.title)).toEqual(['How to File'])

    const mentionsLegalAdvice = sections.filter((s) =>
      s.lines.some((l) => 'text' in l && l.text.toLowerCase().includes('legal advice')),
    )
    expect(mentionsLegalAdvice.map((s) => s.title)).toEqual(['How to File'])
  })
})
