import { describe, expect, test } from 'vitest'
import { resolveConfirmed, serviceFactsSchema } from '@/lib/facts'

const valid = {
  branch: 'MarineCorps',
  dischargeDate: '2024-06-01',
  characterization: 'OtherThanHonorable',
  wasGeneralCourtMartial: false,
}

describe('serviceFactsSchema', () => {
  test('accepts a valid fact set', () => {
    expect(serviceFactsSchema.safeParse(valid).success).toBe(true)
  })

  test('rejects an unknown branch', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, branch: 'Starfleet' }).success).toBe(false)
  })

  test('rejects a malformed date', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, dischargeDate: '06/01/2024' }).success).toBe(false)
  })

  test('rejects an unknown characterization', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, characterization: 'Medium' }).success).toBe(false)
  })

  test('rejects impossible calendar dates that match the regex', () => {
    expect(serviceFactsSchema.safeParse({ ...valid, dischargeDate: '2024-13-45' }).success).toBe(false)
    expect(serviceFactsSchema.safeParse({ ...valid, dischargeDate: '2023-02-29' }).success).toBe(false)
    expect(serviceFactsSchema.safeParse({ ...valid, dischargeDate: '2024-02-29' }).success).toBe(true) // leap year
  })
})

describe('resolveConfirmed (the human-confirmation gate)', () => {
  test('extracted facts can NEVER be confirmed, even if requested', () => {
    expect(resolveConfirmed('extracted', true)).toBe(false)
    expect(resolveConfirmed('extracted', false)).toBe(false)
  })

  test('manual facts confirm only when the veteran submits them', () => {
    expect(resolveConfirmed('manual', true)).toBe(true)
    expect(resolveConfirmed('manual', false)).toBe(false)
  })
})
