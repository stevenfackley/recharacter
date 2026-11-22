import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BRANCHES, CHARACTERIZATIONS, CONDITION_CATEGORIES, DRAFT_KINDS, EVIDENCE_STATUSES,
} from './domain'

/**
 * The value sets, in order (pages render their options in this order). Each
 * is pinned explicitly so a change is a visible diff here.
 */
describe('domain value sets', () => {
  test('branches', () => {
    expect(BRANCHES).toEqual(['Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard'])
  })

  test('characterizations', () => {
    expect(CHARACTERIZATIONS).toEqual([
      'Honorable', 'GeneralUnderHonorable', 'OtherThanHonorable',
      'BadConductDischarge', 'DishonorableDischarge', 'Uncharacterized',
    ])
  })

  test('condition categories', () => {
    expect(CONDITION_CATEGORIES).toEqual([
      'ptsd', 'tbi', 'depression_anxiety', 'adjustment_disorder', 'other_mh', 'unsure',
    ])
  })

  test('evidence statuses', () => {
    expect(EVIDENCE_STATUSES).toEqual(['needed', 'requested', 'collected', 'not_applicable'])
  })

  test('draft kinds', () => {
    expect(DRAFT_KINDS).toEqual(['personal_statement', 'cover_letter'])
  })

  test('the module stays import-free, so client code and the task registry can use it', () => {
    const source = readFileSync(path.join(__dirname, 'domain.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
  })
})
