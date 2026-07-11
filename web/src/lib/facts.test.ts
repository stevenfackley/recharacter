import { describe, expect, test } from 'vitest'
import { resolveSource, serviceFactsSchema, type ServiceFacts } from '@/lib/facts'

const valid: ServiceFacts = {
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

describe('resolveSource (provenance on confirm)', () => {
  const extracted = { ...valid, source: 'extracted' as const }

  test('confirming extracted values untouched preserves extracted provenance', () => {
    expect(resolveSource(extracted, valid)).toBe('extracted')
  })

  test('editing ANY field makes the fact set manual', () => {
    expect(resolveSource(extracted, { ...valid, branch: 'Navy' })).toBe('manual')
    expect(resolveSource(extracted, { ...valid, dischargeDate: '2024-06-02' })).toBe('manual')
    expect(resolveSource(extracted, { ...valid, characterization: 'Honorable' })).toBe('manual')
    expect(resolveSource(extracted, { ...valid, wasGeneralCourtMartial: true })).toBe('manual')
  })

  test('no saved row (first manual entry) is manual', () => {
    expect(resolveSource(null, valid)).toBe('manual')
  })

  test('re-confirming an unchanged manual row stays manual', () => {
    expect(resolveSource({ ...valid, source: 'manual' }, valid)).toBe('manual')
  })
})
