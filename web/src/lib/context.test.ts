import { describe, expect, test } from 'vitest'
import { caseContextSchema } from '@/lib/context'

/**
 * The case-context input contract. Pure zod; `getDb` in the same module is lazy
 * so importing it costs nothing. The server action coerces checkbox values to
 * booleans BEFORE parsing, so the schema itself must not accept strings — that
 * is what keeps the coercion in one place.
 */

const VALID = {
  conditionCategory: 'ptsd',
  mstInvolved: false,
  treatedInService: true,
  hasVaRating: false,
} as const

const CATEGORIES = ['ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure'] as const

function issuePaths(input: unknown): string[] {
  const r = caseContextSchema.safeParse(input)
  if (r.success) throw new Error('expected a parse failure')
  return r.error.issues.map((i) => i.path.join('.'))
}

describe('caseContextSchema', () => {
  test('accepts a well-formed context verbatim', () => {
    const r = caseContextSchema.safeParse(VALID)
    expect(r.success).toBe(true)
    expect(r.data).toEqual(VALID)
  })

  test('accepts each of the six condition categories', () => {
    for (const conditionCategory of CATEGORIES) {
      const r = caseContextSchema.safeParse({ ...VALID, conditionCategory })
      expect(r.success, conditionCategory).toBe(true)
      expect(r.data?.conditionCategory).toBe(conditionCategory)
    }
  })

  test('rejects a category outside the enum, naming the field', () => {
    for (const bad of ['starfleet', 'PTSD', '', 'ptsd ']) {
      expect(issuePaths({ ...VALID, conditionCategory: bad }), bad).toEqual(['conditionCategory'])
    }
  })

  test('the category is required', () => {
    const { conditionCategory: _omit, ...rest } = VALID
    void _omit
    expect(issuePaths(rest)).toEqual(['conditionCategory'])
  })

  test('each boolean field is required, and the failure names it', () => {
    for (const field of ['mstInvolved', 'treatedInService', 'hasVaRating'] as const) {
      const input: Record<string, unknown> = { ...VALID }
      delete input[field]
      expect(issuePaths(input), field).toEqual([field])
    }
  })

  test('booleans are not coerced: "on", "true" and 1 are all refused', () => {
    for (const bad of ['on', 'true', 'false', 1, 0, null]) {
      expect(issuePaths({ ...VALID, mstInvolved: bad }), String(bad)).toEqual(['mstInvolved'])
    }
  })

  test('unknown keys are STRIPPED, not rejected and not carried through', () => {
    const r = caseContextSchema.safeParse({ ...VALID, ownerId: 'someone-else', extra: 1 })
    expect(r.success).toBe(true)
    expect(r.data).toEqual(VALID)
    expect(r.data).not.toHaveProperty('ownerId')
    expect(r.data).not.toHaveProperty('extra')
  })

  test('every failure is reported at once, one issue per bad field', () => {
    expect(issuePaths({ conditionCategory: 'nope', mstInvolved: 'on' }).sort()).toEqual(
      ['conditionCategory', 'hasVaRating', 'mstInvolved', 'treatedInService'],
    )
  })
})
