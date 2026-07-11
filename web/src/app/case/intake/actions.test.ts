import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Provenance through the confirm gate (launch-checklist §2): confirmFacts used
 * to stamp every confirmation source: 'manual', erasing the record that the
 * values came from AI extraction. Confirming the extracted values UNTOUCHED
 * must keep source 'extracted' (with confirmed: true); editing any field — or
 * having no saved row at all — records 'manual'.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1', owner_id: 'user-1' }),
}))

vi.mock('@/lib/ai/gateway', () => ({ executeAiTask: vi.fn() }))

// The REAL facts.ts runs against this fake client, so these tests exercise the
// whole confirm path: prior-row lookup → provenance resolution → upsert.
let priorRow: Record<string, unknown> | null = null
const upsertSpy = vi.fn(async (..._args: unknown[]) => ({ error: null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: priorRow }) }) }),
      upsert: upsertSpy,
    }),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  priorRow = null
})

// What uploadAndExtract leaves behind: an unconfirmed extracted row (db shape).
const savedExtracted = {
  id: 'facts-1',
  case_id: 'case-1',
  branch: 'MarineCorps',
  discharge_date: '2024-06-01',
  characterization: 'OtherThanHonorable',
  was_general_court_martial: false,
  source: 'extracted',
  confirmed: false,
}

function confirmForm(over: Partial<Record<string, string>> = {}) {
  const fd = new FormData()
  fd.set('branch', over.branch ?? 'MarineCorps')
  fd.set('dischargeDate', over.dischargeDate ?? '2024-06-01')
  fd.set('characterization', over.characterization ?? 'OtherThanHonorable')
  // Checkbox semantics: present as 'on' when checked, absent otherwise.
  if (over.wasGeneralCourtMartial) fd.set('wasGeneralCourtMartial', over.wasGeneralCourtMartial)
  return fd
}

describe('confirmFacts — provenance through the human-confirmation gate', () => {
  test('confirming unchanged extracted values keeps source extracted (and confirms)', async () => {
    priorRow = savedExtracted
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm())).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      case_id: 'case-1', source: 'extracted', confirmed: true,
    })
    expect(redirectSpy).toHaveBeenCalledWith('/case')
  })

  test('editing any field records manual', async () => {
    priorRow = savedExtracted
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ dischargeDate: '2024-06-02' }))).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ source: 'manual', confirmed: true })
  })

  test('checking the court-martial box when the extraction said false is an edit', async () => {
    priorRow = savedExtracted
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ wasGeneralCourtMartial: 'on' }))).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ source: 'manual', confirmed: true })
  })

  test('an unchanged checked box round-trips: extracted true + "on" is NOT an edit', async () => {
    priorRow = { ...savedExtracted, was_general_court_martial: true }
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ wasGeneralCourtMartial: 'on' }))).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ source: 'extracted', confirmed: true })
  })

  test('no prior facts row (first manual entry) records manual', async () => {
    priorRow = null
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm())).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ source: 'manual', confirmed: true })
  })

  test('re-confirming an already-confirmed extracted row unchanged preserves its source', async () => {
    priorRow = { ...savedExtracted, confirmed: true }
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm())).rejects.toThrow()
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ source: 'extracted', confirmed: true })
  })

  test('invalid input redirects back to intake without saving', async () => {
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ branch: 'Starfleet' }))).rejects.toThrow()
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/case/intake?error='))
  })
})
