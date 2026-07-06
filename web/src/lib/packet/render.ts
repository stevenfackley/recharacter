import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { PacketLine, PacketSection } from './sections'

// Mechanical layout code — one file, no cleverness. Letter page, 72pt margins.
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 72
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

const HEADING_SIZE = 16
const SUBHEADING_SIZE = 13
const BODY_SIZE = 11
const FOOTER_SIZE = 9
const LINE_GAP = 4
const PARAGRAPH_GAP = 10
const HANGING_INDENT = 18

/**
 * Greedy word-wrap. `firstWidth` lets the first line make room for a preceding
 * label (item rows); `restWidth` applies to every wrapped line after that. A
 * single "word" wider than the available width is hard-broken by character —
 * without this, an unbroken run of text (no spaces) would never wrap and
 * would silently run off the page.
 */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  restWidth: number,
  firstWidth: number = restWidth,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let current = ''
  let width = firstWidth

  const flush = () => {
    if (current) lines.push(current)
    current = ''
    width = restWidth
  }

  const breakLongWord = (word: string) => {
    let chunk = ''
    for (const ch of word) {
      const candidate = chunk + ch
      if (chunk && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(chunk)
        width = restWidth
        chunk = ch
      } else {
        chunk = candidate
      }
    }
    return chunk
  }

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate
      continue
    }
    if (font.widthOfTextAtSize(word, size) <= width) {
      flush()
      current = word
    } else {
      flush()
      current = breakLongWord(word)
    }
  }
  if (current) lines.push(current)
  return lines
}

/** pdf-lib: PacketSection[] → Uint8Array (wrapping, pagination). */
export async function renderPacket(
  sections: PacketSection[],
  meta: { title: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(meta.title)

  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const boldFont = await doc.embedFont(StandardFonts.TimesRomanBold)

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN
  let pageHasContent = false

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
    pageHasContent = false
  }

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) newPage()
  }

  const drawTextLine = (text: string, textFont: PDFFont, size: number, x: number) => {
    const height = size + LINE_GAP
    ensureSpace(height)
    page.drawText(text, { x, y: y - size, size, font: textFont })
    y -= height
    pageHasContent = true
  }

  const renderWrapped = (text: string, textFont: PDFFont, size: number) => {
    for (const line of wrapText(text, textFont, size, CONTENT_WIDTH)) drawTextLine(line, textFont, size, MARGIN)
    y -= PARAGRAPH_GAP
  }

  // Item lines render "label:" bold + value wrapped with a hanging indent. When
  // the label alone is too wide to leave room for any value text next to it,
  // the value drops to its own indented line(s) below instead.
  const renderItem = (label: string, value: string) => {
    const labelText = `${label}:`
    const labelWidth = boldFont.widthOfTextAtSize(labelText, BODY_SIZE)
    const restWidth = CONTENT_WIDTH - HANGING_INDENT
    const firstAvailable = CONTENT_WIDTH - labelWidth - 6

    ensureSpace(BODY_SIZE + LINE_GAP)
    page.drawText(labelText, { x: MARGIN, y: y - BODY_SIZE, size: BODY_SIZE, font: boldFont })

    if (firstAvailable > 60) {
      const valueLines = wrapText(value, font, BODY_SIZE, restWidth, firstAvailable)
      if (valueLines[0] !== undefined) {
        page.drawText(valueLines[0], { x: MARGIN + labelWidth + 6, y: y - BODY_SIZE, size: BODY_SIZE, font })
      }
      y -= BODY_SIZE + LINE_GAP
      pageHasContent = true
      for (const line of valueLines.slice(1)) drawTextLine(line, font, BODY_SIZE, MARGIN + HANGING_INDENT)
    } else {
      y -= BODY_SIZE + LINE_GAP
      pageHasContent = true
      for (const line of wrapText(value, font, BODY_SIZE, restWidth)) drawTextLine(line, font, BODY_SIZE, MARGIN + HANGING_INDENT)
    }
    y -= PARAGRAPH_GAP
  }

  const renderLine = (line: PacketLine) => {
    switch (line.kind) {
      case 'heading':
        renderWrapped(line.text, boldFont, HEADING_SIZE)
        break
      case 'subheading':
        renderWrapped(line.text, boldFont, SUBHEADING_SIZE)
        break
      case 'body':
        renderWrapped(line.text, font, BODY_SIZE)
        break
      case 'item':
        renderItem(line.label, line.value)
        break
      case 'spacer':
        y -= LINE_GAP
        break
    }
  }

  for (const section of sections) {
    if (section.startOnNewPage && pageHasContent) newPage()
    for (const line of section.lines) renderLine(line)
  }

  // Footers need the final page count, so they're drawn in a second pass.
  const pages = doc.getPages()
  const total = pages.length
  pages.forEach((p, idx) => {
    const footer = `Page ${idx + 1} of ${total} — generated ${meta.title}`
    const footerWidth = font.widthOfTextAtSize(footer, FOOTER_SIZE)
    p.drawText(footer, {
      x: (PAGE_WIDTH - footerWidth) / 2,
      y: MARGIN / 2,
      size: FOOTER_SIZE,
      font,
      color: rgb(0.45, 0.45, 0.45),
    })
  })

  return doc.save()
}
