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

  test('only the literal checkbox value "on" counts as confirmation', () => {
    // The confirm value comes off a FormData field. A checked checkbox submits
    // exactly 'on'; anything that merely LOOKS affirmative (a JSON true, a
    // "true" string, a 1, a differently-cased "ON") is not the veteran ticking
    // the box and must not unlock the overwrite.
    for (const notConfirm of [true, 'true', 1, 'ON', 'On', ' on', 'on ', 'yes', ['on'], { on: true }]) {
      expect(regenerateAllowedFor({ edited: true }, notConfirm), JSON.stringify(notConfirm)).toBe(false)
    }
  })

  test('the confirm value is irrelevant when nothing edited is at stake', () => {
    for (const anything of [null, undefined, '', 'off', 'on', true, 1]) {
      expect(regenerateAllowedFor(null, anything)).toBe(true)
      expect(regenerateAllowedFor({ edited: false }, anything)).toBe(true)
    }
  })
})
