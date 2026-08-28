import { describe, expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { renderPacket } from '@/lib/packet/render'
import type { PacketSection } from '@/lib/packet/sections'

describe('renderPacket', () => {
  test('produces a valid PDF that pdf-lib can load back, honoring startOnNewPage and title metadata', async () => {
    const sections: PacketSection[] = [
      {
        title: 'Section One',
        startOnNewPage: false,
        lines: [
          { kind: 'heading', text: 'Section One' },
          { kind: 'body', text: 'Some body text.' },
          { kind: 'item', label: 'A label', value: 'A value' },
        ],
      },
      {
        title: 'Section Two',
        startOnNewPage: true,
        lines: [
          { kind: 'heading', text: 'Section Two' },
          { kind: 'body', text: 'More body text.' },
        ],
      },
    ]

    const bytes = await renderPacket(sections, { title: 'Test Packet — 2026-07-06' })

    expect(Buffer.from(bytes.slice(0, 4)).toString('utf-8')).toBe('%PDF')

    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(2)
    expect(loaded.getTitle()).toBe('Test Packet — 2026-07-06')
  })

  test('wrap regression: a long unbroken "word" is hard-broken and forces pagination rather than overflowing', async () => {
    const longWord = 'W'.repeat(2000)
    const sections: PacketSection[] = [
      {
        title: 'Long',
        startOnNewPage: false,
        lines: [{ kind: 'body', text: longWord }],
      },
    ]
    const bytes = await renderPacket(sections, { title: 'Wrap Test' })
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThan(1)
  })

  // pdf-lib's StandardFonts are WinAnsi-only and *throw* on any codepoint
  // outside that encoding. A veteran's personal statement is free text — it
  // will contain non-ASCII names, accented characters, Word's smart
  // punctuation (U+2011 non-breaking hyphen, curly quotes), and occasionally
  // emoji. This must render, not 500.
  test('non-WinAnsi text (Cyrillic, emoji, non-breaking hyphen, arrow) renders without throwing', async () => {
    const statement = 'José Nguyễn — Привет 🚀 → non‑breaking'
    const sections: PacketSection[] = [
      {
        title: 'Personal Statement',
        startOnNewPage: false,
        lines: [
          { kind: 'heading', text: 'Personal Statement' },
          { kind: 'body', text: statement },
          { kind: 'item', label: statement, value: statement },
        ],
      },
    ]

    const bytes = await renderPacket(sections, { title: 'Unicode Test' })

    expect(Buffer.from(bytes.slice(0, 4)).toString('utf-8')).toBe('%PDF')
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})
