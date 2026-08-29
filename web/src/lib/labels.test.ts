import { describe, expect, test } from 'vitest'
import {
  BRANCH_LABELS,
  CHARACTERIZATION_LABELS,
  EVIDENCE_STATUS_LABELS,
  branchLabel,
  characterizationLabel,
  evidenceStatusLabel,
} from '@/lib/labels'

/**
 * ATTORNEY-REVIEW SURFACE (see the header of lib/labels.ts): the branch and
 * characterization wordings are the words printed on the official DD forms and
 * the UI and packet render them identically. Every entry is pinned with an
 * explicit `toBe` — no snapshot — so a wording change is a visible diff in the
 * test, not a silently regenerated fixture.
 */

describe('BRANCH_LABELS', () => {
  test('contains exactly the six branches', () => {
    expect(Object.keys(BRANCH_LABELS)).toEqual([
      'Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard',
    ])
  })

  test('Army', () => { expect(BRANCH_LABELS.Army).toBe('Army') })
  test('Navy', () => { expect(BRANCH_LABELS.Navy).toBe('Navy') })
  test('MarineCorps', () => { expect(BRANCH_LABELS.MarineCorps).toBe('Marine Corps') })
  test('AirForce', () => { expect(BRANCH_LABELS.AirForce).toBe('Air Force') })
  test('SpaceForce', () => { expect(BRANCH_LABELS.SpaceForce).toBe('Space Force') })
  test('CoastGuard', () => { expect(BRANCH_LABELS.CoastGuard).toBe('Coast Guard') })
})

describe('CHARACTERIZATION_LABELS', () => {
  test('contains exactly the six characterizations', () => {
    expect(Object.keys(CHARACTERIZATION_LABELS)).toEqual([
      'Honorable',
      'GeneralUnderHonorable',
      'OtherThanHonorable',
      'BadConductDischarge',
      'DishonorableDischarge',
      'Uncharacterized',
    ])
  })

  test('Honorable', () => {
    expect(CHARACTERIZATION_LABELS.Honorable).toBe('Honorable')
  })
  test('GeneralUnderHonorable', () => {
    expect(CHARACTERIZATION_LABELS.GeneralUnderHonorable).toBe('General (Under Honorable Conditions)')
  })
  test('OtherThanHonorable', () => {
    expect(CHARACTERIZATION_LABELS.OtherThanHonorable).toBe('Under Other Than Honorable Conditions')
  })
  test('BadConductDischarge', () => {
    expect(CHARACTERIZATION_LABELS.BadConductDischarge).toBe('Bad Conduct')
  })
  test('DishonorableDischarge', () => {
    expect(CHARACTERIZATION_LABELS.DishonorableDischarge).toBe('Dishonorable')
  })
  test('Uncharacterized', () => {
    expect(CHARACTERIZATION_LABELS.Uncharacterized).toBe('Uncharacterized (Entry-Level Separation)')
  })
})

describe('EVIDENCE_STATUS_LABELS', () => {
  test('contains exactly the four statuses', () => {
    expect(Object.keys(EVIDENCE_STATUS_LABELS)).toEqual([
      'needed', 'requested', 'collected', 'not_applicable',
    ])
  })

  test('needed', () => { expect(EVIDENCE_STATUS_LABELS.needed).toBe('Needed') })
  test('requested', () => { expect(EVIDENCE_STATUS_LABELS.requested).toBe('Requested') })
  test('collected', () => { expect(EVIDENCE_STATUS_LABELS.collected).toBe('Collected') })
  test('not_applicable', () => { expect(EVIDENCE_STATUS_LABELS.not_applicable).toBe('Not applicable') })
})

describe('label helpers', () => {
  test('branchLabel returns the table value for every known key', () => {
    for (const [key, label] of Object.entries(BRANCH_LABELS)) {
      expect(branchLabel(key), key).toBe(label)
    }
  })

  test('characterizationLabel returns the table value for every known key', () => {
    for (const [key, label] of Object.entries(CHARACTERIZATION_LABELS)) {
      expect(characterizationLabel(key), key).toBe(label)
    }
  })

  test('evidenceStatusLabel returns the table value for every known key', () => {
    for (const [key, label] of Object.entries(EVIDENCE_STATUS_LABELS)) {
      expect(evidenceStatusLabel(key), key).toBe(label)
    }
  })

  test('an unknown key passes through unchanged rather than rendering as blank', () => {
    // The enums mirror the .NET RulesEngine verbatim; a value this map has not
    // caught up with should still be legible on screen and in the packet.
    expect(branchLabel('Starfleet')).toBe('Starfleet')
    expect(characterizationLabel('SomethingNew')).toBe('SomethingNew')
    expect(evidenceStatusLabel('pending')).toBe('pending')
  })

  test('an empty string is passed through, not swapped for a default', () => {
    expect(branchLabel('')).toBe('')
    expect(characterizationLabel('')).toBe('')
    expect(evidenceStatusLabel('')).toBe('')
  })
})
