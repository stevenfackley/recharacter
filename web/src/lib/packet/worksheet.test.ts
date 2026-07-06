import { describe, expect, test } from 'vitest'
import { buildWorksheet } from '@/lib/packet/worksheet'
import type { PacketInput } from '@/lib/packet/sections'

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
  statement: 'My statement.',
  coverLetter: null,
  evidence: [],
}

const dd149Input: PacketInput = {
  ...baseInput,
  routing: { ...baseInput.routing, boardName: 'BCNR', recommendedForm: 'DD149', drbWindowOpen: false },
}

/** Find the single row whose item starts with the given item token. */
function row(rows: ReturnType<typeof buildWorksheet>, itemToken: string) {
  const matches = rows.filter((r) => r.item.startsWith(itemToken + ' '))
  expect(matches, `expected exactly one row for "${itemToken}"`).toHaveLength(1)
  return matches[0]
}

describe('buildWorksheet — golden master pinned to the OFFICIAL form revisions', () => {
  // Item numbers below were verified against the text of DD Form 293 (DEC 2019)
  // and DD Form 149 (JAN 2023). If these tests fail after a "renumbering",
  // somebody must re-verify against the current official forms — a wrong item
  // number sends a veteran's answer into the wrong box.

  test('DD-293 (DEC 2019): the load-bearing item numbers', () => {
    const rows = buildWorksheet(baseInput)
    expect(row(rows, 'Item 1').value).toBe('Marine Corps') // branch is Item 1, humanized
    expect(row(rows, 'Item 5a').value).toMatch(/social security/i)
    expect(row(rows, 'Item 8').value).toBe('2015-04-01') // date of discharge
    expect(row(rows, 'Item 11').value).toBe('Under Other Than Honorable Conditions')
    expect(row(rows, 'Item 18').value).toMatch(/characterization you are requesting/i)
    expect(row(rows, 'Item 22').value).toBe('SEE ATTACHED STATEMENT')
    expect(row(rows, 'Item 29a').value).toMatch(/sign by hand/i)
    expect(row(rows, 'Item 29b').item).toMatch(/date signed/i)
  })

  test('DD-149 (JAN 2023): the load-bearing item numbers', () => {
    const rows = buildWorksheet(dd149Input)
    expect(row(rows, 'Item 1').value).toBe('Marine Corps')
    expect(row(rows, 'Item 5a').value).toMatch(/social security/i)
    expect(row(rows, 'Item 7').value).toBe('2015-04-01') // date of separation
    expect(row(rows, 'Item 10').value).toBe('Under Other Than Honorable Conditions')
    expect(row(rows, 'Item 13').value).toMatch(/upgrade of my characterization/i)
    expect(row(rows, 'Item 15').value).toBe('SEE ATTACHED STATEMENT')
    expect(row(rows, 'Item 27a').value).toMatch(/sign by hand/i)
  })

  test('no invented item numbers survive (the misnumbering regression)', () => {
    for (const input of [baseInput, dd149Input]) {
      const items = buildWorksheet(input).map((r) => r.item)
      // These were the invented rows from the original implementation:
      expect(items.some((i) => i.startsWith('Item 3a'))).toBe(false)
      expect(items.some((i) => i.startsWith('Item 3b'))).toBe(false)
      expect(items.some((i) => i.startsWith('Item 2 '))).toBe(false)
      // DD-149 has no "unit at discharge" field at all:
      if (input.routing.recommendedForm === 'DD149') {
        expect(items.some((i) => /unit/i.test(i))).toBe(false)
      }
    }
  })

  test('raw enum names never appear — values are humanized form labels', () => {
    for (const input of [baseInput, dd149Input]) {
      const flat = JSON.stringify(buildWorksheet(input))
      expect(flat).not.toContain('MarineCorps')
      expect(flat).not.toContain('OtherThanHonorable')
    }
  })

  test('every row has a non-empty item and value; placeholders stay bracketed', () => {
    for (const input of [baseInput, dd149Input]) {
      const rows = buildWorksheet(input)
      expect(rows.length).toBeGreaterThan(10)
      for (const r of rows) {
        expect(r.item.trim().length).toBeGreaterThan(0)
        expect(r.value.trim().length).toBeGreaterThan(0)
      }
      const nameRow = rows.find((r) => /current name/i.test(r.item))
      expect(nameRow?.value).toMatch(/^\[.*\]$/)
    }
  })
})
