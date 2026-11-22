import { describe, expect, test } from 'vitest'
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as schema from '@/db/schema'
import { OWNER_TABLES, serializeRow } from './account'

/**
 * "Delete everything" is only as complete as OWNER_TABLES. These tests derive
 * the owner-scoped tables from the schema itself, so a new table with an
 * owner_id column fails here until deleteAccountData knows how to remove it.
 */
describe('OWNER_TABLES', () => {
  const schemaTables = (Object.values(schema) as unknown[]).filter((x): x is PgTable => is(x, PgTable))
  const ownerScoped = schemaTables.filter((t) => 'ownerId' in getTableColumns(t))
  const names = OWNER_TABLES.map((t) => getTableName(t.table))

  test('lists every schema table with an owner_id column, each once', () => {
    expect([...names].sort()).toEqual(ownerScoped.map(getTableName).sort())
    expect(new Set(names).size).toBe(names.length)
  })

  test('every entry filters and counts on its own table\'s columns', () => {
    for (const t of OWNER_TABLES) {
      const columns = Object.values(getTableColumns(t.table))
      expect(t.ownerId, getTableName(t.table)).toBe(getTableColumns(t.table).ownerId)
      expect(columns, getTableName(t.table)).toContain(t.key)
    }
  })

  test('exactly the tables hanging off a case are counted and re-checked rather than deleted directly', () => {
    const viaCascade = OWNER_TABLES.filter((t) => t.kind === 'caseScoped').map((t) => getTableName(t.table)).sort()
    const withCaseId = ownerScoped.filter((t) => 'caseId' in getTableColumns(t)).map(getTableName).sort()
    expect(viaCascade).toEqual(withCaseId)
    expect(OWNER_TABLES.filter((t) => t.kind === 'case').map((t) => t.table)).toEqual([schema.cases])
  })
})

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
