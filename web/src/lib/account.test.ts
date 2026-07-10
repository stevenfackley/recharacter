import { describe, expect, test, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { collectExport, deleteAccountData, listUserObjects } from './account'

type StorageEntry = { name: string; id: string | null }

function stubClient(opts: {
  rows?: Record<string, Record<string, unknown>[]>
  storage?: Record<string, StorageEntry[]>
  removeSpy?: ReturnType<typeof vi.fn>
}) {
  const rows = opts.rows ?? {}
  const storage = opts.storage ?? {}
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const data = rows[table] ?? []
          // PostgrestFilterBuilder is awaitable directly AND exposes maybeSingle —
          // mirror both so the stub works for list-tables and one-row tables alike.
          return Object.assign(Promise.resolve({ data }), {
            maybeSingle: async () => ({ data: data[0] ?? null }),
          })
        },
      }),
    }),
    storage: {
      from: () => ({
        list: async (folder: string) => ({ data: storage[folder] ?? [], error: null }),
        remove: opts.removeSpy ?? (async () => ({ error: null })),
      }),
    },
  } as unknown as SupabaseClient
}

describe('listUserObjects', () => {
  test('walks nested case folders down to the files', async () => {
    const client = stubClient({
      storage: {
        'user-1': [{ name: 'case-1', id: null }, { name: 'stray.txt', id: 'obj-0' }],
        'user-1/case-1': [{ name: 'dd214.pdf', id: 'obj-1' }, { name: 'records.pdf', id: 'obj-2' }],
      },
    })
    const paths = await listUserObjects(client, 'user-1')
    expect(paths.sort()).toEqual([
      'user-1/case-1/dd214.pdf',
      'user-1/case-1/records.pdf',
      'user-1/stray.txt',
    ])
  })
})

describe('collectExport', () => {
  const FULL_ROWS = {
    cases: [{ id: 'case-1', owner_id: 'user-1' }],
    service_facts: [{ branch: 'MarineCorps', characterization: 'OtherThanHonorable' }],
    case_context: [{ condition_category: 'adjustment_disorder' }],
    evidence_items: [{ item_type: 'dd214', status: 'collected' }],
    nexus_answers: [{ q1_condition: 'my own words' }],
    drafts: [{ kind: 'personal_statement', content: 'draft text' }],
    ai_usage: [{ task: 'ping', input_tokens: 1, output_tokens: 1 }],
    entitlements: [{ kind: 'case_unlock', created_at: '2026-07-01' }],
    ai_credentials: [{ created_at: '2026-07-01', encrypted_key: 'CIPHERTEXT-MUST-NOT-LEAK' }],
  }

  test('assembles every section the veteran owns', async () => {
    const client = stubClient({
      rows: FULL_ROWS,
      storage: { 'user-1': [{ name: 'case-1', id: null }], 'user-1/case-1': [{ name: 'dd214.pdf', id: 'o1' }] },
    })
    const result = await collectExport(client, 'user-1', 'vet@example.test')

    expect(result.userId).toBe('user-1')
    expect(result.email).toBe('vet@example.test')
    expect(result.case).toEqual(FULL_ROWS.cases[0])
    expect(result.serviceFacts).toEqual(FULL_ROWS.service_facts[0])
    expect(result.caseContext).toEqual(FULL_ROWS.case_context[0])
    expect(result.evidenceItems).toEqual(FULL_ROWS.evidence_items)
    expect(result.nexusAnswers).toEqual(FULL_ROWS.nexus_answers[0])
    expect(result.drafts).toEqual(FULL_ROWS.drafts)
    expect(result.aiUsage).toEqual(FULL_ROWS.ai_usage)
    expect(result.entitlements).toEqual(FULL_ROWS.entitlements)
    expect(result.byokConfigured).toBe(true)
    expect(result.uploadedDocuments).toEqual(['user-1/case-1/dd214.pdf'])
  })

  test('the BYOK ciphertext never appears anywhere in the export', async () => {
    const client = stubClient({ rows: FULL_ROWS })
    const result = await collectExport(client, 'user-1', null)
    expect(JSON.stringify(result)).not.toContain('CIPHERTEXT-MUST-NOT-LEAK')
    expect(JSON.stringify(result)).not.toContain('encrypted_key')
  })

  test('an empty account exports as empty sections, byok false', async () => {
    const client = stubClient({})
    const result = await collectExport(client, 'user-1', null)
    expect(result.case).toBeNull()
    expect(result.evidenceItems).toEqual([])
    expect(result.byokConfigured).toBe(false)
    expect(result.uploadedDocuments).toEqual([])
  })
})

describe('deleteAccountData', () => {
  test('sweeps storage then deletes the auth user (which cascades the rows)', async () => {
    const removeSpy = vi.fn(async () => ({ error: null }))
    const userClient = stubClient({
      storage: { 'user-1': [{ name: 'case-1', id: null }], 'user-1/case-1': [{ name: 'dd214.pdf', id: 'o1' }] },
      removeSpy,
    })
    const deleteUser = vi.fn(async () => ({ error: null }))
    const adminClient = { auth: { admin: { deleteUser } } } as unknown as SupabaseClient

    await deleteAccountData({ userClient, adminClient, userId: 'user-1' })
    expect(removeSpy).toHaveBeenCalledWith(['user-1/case-1/dd214.pdf'])
    expect(deleteUser).toHaveBeenCalledWith('user-1')
  })

  test('skips the storage call when there is nothing uploaded', async () => {
    const removeSpy = vi.fn(async () => ({ error: null }))
    const userClient = stubClient({ removeSpy })
    const deleteUser = vi.fn(async () => ({ error: null }))
    const adminClient = { auth: { admin: { deleteUser } } } as unknown as SupabaseClient

    await deleteAccountData({ userClient, adminClient, userId: 'user-1' })
    expect(removeSpy).not.toHaveBeenCalled()
    expect(deleteUser).toHaveBeenCalled()
  })

  test('throws (never reports success) when the auth-user delete fails', async () => {
    const userClient = stubClient({})
    const adminClient = {
      auth: { admin: { deleteUser: async () => ({ error: new Error('admin api down') }) } },
    } as unknown as SupabaseClient

    await expect(
      deleteAccountData({ userClient, adminClient, userId: 'user-1' }),
    ).rejects.toThrow()
  })
})
