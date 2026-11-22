import { beforeEach, describe, expect, test, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

/**
 * The deletion transaction, statement by statement, without a database: a
 * drizzle pg-proxy instance stands in for the transaction handle and records
 * every SQL string and parameter list it is asked to run. The integration
 * suite (tests/account-deletion.integration.test.ts) proves the same thing
 * against real Postgres in CI; this pins the exact statements and their order
 * so a change to how they are built is visible on any machine.
 */

const OWNER = '00000000-0000-4000-8000-00000000f1f0'

type Recorded = { sql: string; params: unknown[] }
let recorded: Recorded[] = []
/** Rows each SELECT on a table returns, by visit: [count read, survivor re-check]. */
let selectRows: Record<string, number[]> = {}

const tableOf = (q: string) => /"recharacter"\."([a-z_]+)"/.exec(q)?.[1] ?? '?'

const tx = drizzle(async (sql, params) => {
  recorded.push({ sql, params })
  if (sql.startsWith('delete')) return { rows: [['row-1']] }
  if (sql.startsWith('select')) {
    const plan = (selectRows[tableOf(sql)] ??= [1, 0])
    const n = plan.shift() ?? 0
    return { rows: Array.from({ length: n }, (_, i) => [`row-${i + 1}`]) }
  }
  return { rows: [] }
})

vi.mock('@/db', () => ({
  getDb: () => ({ transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }),
}))

const mockRemoveOwnerDocuments = vi.fn()
vi.mock('@/lib/case-documents', () => ({
  listOwnerDocuments: vi.fn(),
  removeOwnerDocuments: (...args: unknown[]) => mockRemoveOwnerDocuments(...args),
}))
vi.mock('@/lib/keycloak-admin', () => ({
  createKeycloakAdmin: () => { throw new Error('the tests pass their own admin') },
}))

import { deleteAccountData } from './account'

const store = { kind: 'store-fixture' } as never
const admin = () => ({ getToken: vi.fn(async () => 'tok'), deleteUser: vi.fn(async () => {}) })

beforeEach(() => {
  recorded = []
  selectRows = {}
  mockRemoveOwnerDocuments.mockReset().mockResolvedValue(3)
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('deleteAccountData, statement by statement', () => {
  test('the transaction runs exactly these statements, in this order', async () => {
    await deleteAccountData(OWNER, { store, admin: admin() })
    expect(recorded.map((r) => r.sql)).toMatchSnapshot()
  })

  test('every statement after the ledger switch is scoped to the owner, and only to the owner', async () => {
    await deleteAccountData(OWNER, { store, admin: admin() })
    const [setLocal, ...rest] = recorded
    expect(setLocal).toEqual({ sql: `SET LOCAL recharacter.allow_ledger_delete = 'on'`, params: [] })
    // Five direct deletes, five counts, the cases delete, five re-checks.
    expect(rest).toHaveLength(16)
    for (const r of rest) {
      expect(r.params, r.sql).toEqual([OWNER])
      expect(r.sql, r.sql).toMatch(/where "recharacter"\."[a-z_]+"\."owner_id" = \$1/)
    }
  })

  test('the receipt names every table, in order, with what this call removed', async () => {
    const deleteUser = vi.fn(async () => {})
    const result = await deleteAccountData(OWNER, { store, admin: { getToken: async () => 'tok', deleteUser } })

    expect(Object.keys(result.rowsByTable)).toEqual([
      'ai_usage', 'entitlements', 'pending_checkouts', 'ai_credentials', 'ai_attempts',
      'service_facts', 'case_context', 'evidence_items', 'nexus_answers', 'drafts', 'cases',
    ])
    expect(Object.values(result.rowsByTable).every((n) => n === 1)).toBe(true)
    expect(result.objects).toBe(3)
    expect(mockRemoveOwnerDocuments).toHaveBeenCalledWith(store, OWNER)
    expect(deleteUser).toHaveBeenCalledWith(OWNER, 'tok')
    expect(console.info).toHaveBeenCalledWith('account deleted', { rowsByTable: result.rowsByTable, objects: 3 })
  })

  test('the counts are what the reads saw, not a constant', async () => {
    selectRows = { evidence_items: [4, 0], drafts: [0, 0] }
    const result = await deleteAccountData(OWNER, { store, admin: admin() })
    expect(result.rowsByTable.evidence_items).toBe(4)
    expect(result.rowsByTable.drafts).toBe(0)
  })

  test('a case-scoped row that survives the cascade rolls the whole thing back, naming its tables', async () => {
    selectRows = { case_context: [1, 1], drafts: [1, 2] }
    const a = admin()

    await expect(deleteAccountData(OWNER, { store, admin: a })).rejects.toThrow(
      'rows survived the case cascade in case_context, drafts; deletion rolled back',
    )
    expect(mockRemoveOwnerDocuments).not.toHaveBeenCalled()
    expect(a.deleteUser).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
  })

  test('nothing is touched when the identity provider refuses our credentials', async () => {
    const a = admin()
    a.getToken.mockRejectedValueOnce(new Error('token endpoint returned 401'))

    await expect(deleteAccountData(OWNER, { store, admin: a })).rejects.toThrow('401')
    expect(recorded).toEqual([])
    expect(mockRemoveOwnerDocuments).not.toHaveBeenCalled()
  })
})
