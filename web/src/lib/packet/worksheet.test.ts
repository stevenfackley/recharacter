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

describe('buildWorksheet', () => {
  test('every row has a non-empty item and value', () => {
    const rows = buildWorksheet(baseInput)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.item.trim().length).toBeGreaterThan(0)
      expect(row.value.trim().length).toBeGreaterThan(0)
    }
  })

  test('DD293 rows carry the branch, discharge date, a SEE ATTACHED STATEMENT row, and bracketed name/SSN placeholders', () => {
    const rows = buildWorksheet(baseInput)
    expect(rows.some((r) => r.value === baseInput.facts.branch)).toBe(true)
    expect(rows.some((r) => r.value === baseInput.facts.dischargeDate)).toBe(true)
    expect(rows.some((r) => r.value === 'SEE ATTACHED STATEMENT')).toBe(true)

    const nameRow = rows.find((r) => /full name/i.test(r.item))
    const ssnRow = rows.find((r) => /social security/i.test(r.item))
    expect(nameRow?.value).toMatch(/^\[.*\]$/)
    expect(ssnRow?.value).toMatch(/^\[.*\]$/)
  })

  test('the requested-characterization row contains bracketed guidance', () => {
    const rows = buildWorksheet(baseInput)
    const row = rows.find((r) => /requested/i.test(r.item))
    expect(row).toBeTruthy()
    expect(row?.value).toMatch(/^\[.*\]$/)
    expect(row?.value.toLowerCase()).toContain('honorable')
  })

  test('DD149 variant produced when routing recommends DD149', () => {
    const dd149Input: PacketInput = {
      ...baseInput,
      routing: { ...baseInput.routing, recommendedForm: 'DD149' },
    }
    const rows = buildWorksheet(dd149Input)
    expect(rows.some((r) => /record correction/i.test(r.item))).toBe(true)
    expect(rows.some((r) => r.value === 'SEE ATTACHED STATEMENT')).toBe(true)
    expect(rows.some((r) => r.value === baseInput.facts.branch)).toBe(true)
    for (const row of rows) {
      expect(row.item.trim().length).toBeGreaterThan(0)
      expect(row.value.trim().length).toBeGreaterThan(0)
    }
  })
})
