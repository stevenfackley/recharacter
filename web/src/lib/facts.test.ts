import { describe, expect, test } from 'vitest'
import { serviceFactsSchema } from '@/lib/facts'

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
})
