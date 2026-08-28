import { describe, expect, test } from 'vitest'
import { regenerateAllowedFor } from '@/lib/drafts'

describe('regenerateAllowedFor (the regeneration confirm-gate)', () => {
  test('fresh generation (no prior draft) needs no confirmation', () => {
    expect(regenerateAllowedFor(null, null)).toBe(true)
  })

  test('a machine-only draft (never edited) regenerates freely', () => {
    expect(regenerateAllowedFor({ edited: false }, null)).toBe(true)
  })

  test('an EDITED draft is never silently overwritten', () => {
    expect(regenerateAllowedFor({ edited: true }, null)).toBe(false)
    expect(regenerateAllowedFor({ edited: true }, '')).toBe(false)
    expect(regenerateAllowedFor({ edited: true }, 'off')).toBe(false)
  })

  test('an edited draft regenerates only with the explicit confirm', () => {
    expect(regenerateAllowedFor({ edited: true }, 'on')).toBe(true)
  })
})
