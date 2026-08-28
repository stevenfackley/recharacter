import { describe, expect, test } from 'vitest'
import { serializeRow } from './account'

/**
 * The export is a document handed to a veteran, so its keys must stay the
 * database's own names (what our schema and any lawyer reading it call them),
 * not Drizzle's JS field names — and its dates must be strings, not objects
 * that only happen to serialize when someone remembers to JSON.stringify.
 *
 * Everything else about the export and the deletion needs real rows, a real
 * store and the real ledger guard: see tests/account-deletion.integration.test.ts.
 */
describe('serializeRow', () => {
  test('renames Drizzle field names back to their Postgres columns', () => {
    expect(serializeRow({
      id: 'row-1',
      ownerId: 'owner-1',
      caseId: 'case-1',
      wasGeneralCourtMartial: false,
      dischargeDate: '2015-04-01',
      q1Condition: 'my own words',
    })).toEqual({
      id: 'row-1',
      owner_id: 'owner-1',
      case_id: 'case-1',
      was_general_court_martial: false,
      discharge_date: '2015-04-01',
      q1_condition: 'my own words',
    })
  })

  test('dates become ISO strings', () => {
    const createdAt = new Date('2026-07-01T12:30:00.000Z')
    expect(serializeRow({ createdAt })).toEqual({ created_at: '2026-07-01T12:30:00.000Z' })
  })

  test('nulls and empty rows survive without inventing values', () => {
    expect(serializeRow({ notes: null })).toEqual({ notes: null })
    expect(serializeRow({})).toEqual({})
  })

  test('a missing row stays null rather than becoming an empty object', () => {
    expect(serializeRow(null)).toBeNull()
    expect(serializeRow(undefined)).toBeNull()
  })
})
