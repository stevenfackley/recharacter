import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EVIDENCE_CATALOG, recommendEvidence, scoreCase, type CaseContext } from '@/lib/evidence'

/**
 * The evidence-page actions. The coaching-note TRANSPORT (result, never a
 * redirect) lives in coaching-transport.test.ts; this file covers the rest:
 * the early exits of requestCoaching and what it feeds the prompt, the form
 * coercion and failure codes of saveContext, and the session-before-validation
 * order of setItemStatus. The rubric (lib/evidence) is real — it is pure.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

const revalidateSpy = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidateSpy(...args) }))

const mockGetSessionUser = vi.fn()
const mockRequireSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
  requireSessionUser: (...args: unknown[]) => mockRequireSessionUser(...args),
}))

const mockGetOrCreateCase = vi.fn()
vi.mock('@/lib/cases', () => ({
  getOrCreateCase: (...args: unknown[]) => mockGetOrCreateCase(...args),
}))

const mockGetCaseContext = vi.fn()
const mockSaveCaseContext = vi.fn()
vi.mock('@/lib/context', async (importOriginal) => {
  // The REAL schema — the form coercion feeding it is what saveContext is for.
  const actual = await importOriginal<typeof import('@/lib/context')>()
  return {
    caseContextSchema: actual.caseContextSchema,
    getCaseContext: (...args: unknown[]) => mockGetCaseContext(...args),
    saveCaseContext: (...args: unknown[]) => mockSaveCaseContext(...args),
  }
})

const mockGetEvidenceStatuses = vi.fn()
const mockSetEvidenceStatus = vi.fn()
vi.mock('@/lib/evidence-items', () => ({
  getEvidenceStatuses: (...args: unknown[]) => mockGetEvidenceStatuses(...args),
  setEvidenceStatus: (...args: unknown[]) => mockSetEvidenceStatus(...args),
}))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

const USER = { id: 'user-1', email: null }
const CTX: CaseContext = {
  conditionCategory: 'adjustment_disorder',
  mstInvolved: false,
  treatedInService: false,
  hasVaRating: false,
}

type CoachingInput = {
  score: number
  band: 'building' | 'developing' | 'strong'
  topGapLabel: string | null
  collectedLabels: string[]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockGetSessionUser.mockResolvedValue(USER)
  mockRequireSessionUser.mockResolvedValue(USER)
  mockGetOrCreateCase.mockResolvedValue({ id: 'case-1' })
  mockGetCaseContext.mockResolvedValue(CTX)
  mockGetEvidenceStatuses.mockResolvedValue({})
  mockExecute.mockResolvedValue({ ok: true, data: { note: 'ok' } })
})

function contextForm(over: Partial<Record<string, string>> = {}) {
  const fd = new FormData()
  fd.set('conditionCategory', over.conditionCategory ?? 'ptsd')
  for (const box of ['mstInvolved', 'treatedInService', 'hasVaRating']) {
    if (over[box] !== undefined) fd.set(box, over[box]!)
  }
  return fd
}

function statusForm(itemType: string, status: string) {
  const fd = new FormData()
  fd.set('itemType', itemType)
  fd.set('status', status)
  return fd
}

describe('requestCoaching — early exits', () => {
  test('no session → { note: null }, and nothing else is looked up', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const { requestCoaching } = await import('./actions')

    await expect(requestCoaching({ note: null }, new FormData())).resolves.toEqual({ note: null })
    expect(mockGetOrCreateCase).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('no saved case context → { note: null }, the model is never called', async () => {
    mockGetCaseContext.mockResolvedValue(null)
    const { requestCoaching } = await import('./actions')

    await expect(requestCoaching({ note: null }, new FormData())).resolves.toEqual({ note: null })
    expect(mockGetEvidenceStatuses).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('requestCoaching — what reaches the prompt', () => {
  test('only COLLECTED items appear in collectedLabels; requested and needed do not', async () => {
    mockGetEvidenceStatuses.mockResolvedValue({
      dd214: 'collected',
      personal_statement: 'collected',
      buddy_statement: 'requested',
      nexus_letter: 'needed',
    })
    const { requestCoaching } = await import('./actions')

    await requestCoaching({ note: null }, new FormData())

    const input = mockExecute.mock.calls[0][2] as CoachingInput
    expect(input.collectedLabels).toHaveLength(2)
    expect(input.collectedLabels).toEqual(expect.arrayContaining([
      EVIDENCE_CATALOG.dd214.label,
      EVIDENCE_CATALOG.personal_statement.label,
    ]))
    expect(input.collectedLabels).not.toContain(EVIDENCE_CATALOG.buddy_statement.label)
    expect(input.collectedLabels).not.toContain(EVIDENCE_CATALOG.nexus_letter.label)
  })

  test('collectedLabels follow the rubric order (heaviest first), as the catalog labels', async () => {
    mockGetEvidenceStatuses.mockResolvedValue({ dd214: 'collected', nexus_letter: 'collected' })
    const { requestCoaching } = await import('./actions')

    await requestCoaching({ note: null }, new FormData())

    const input = mockExecute.mock.calls[0][2] as CoachingInput
    expect(input.collectedLabels).toEqual([
      EVIDENCE_CATALOG.nexus_letter.label,
      EVIDENCE_CATALOG.dd214.label,
    ])
  })

  test('a collected status for an item the context does NOT recommend is ignored', async () => {
    // CTX has no VA rating and no in-service treatment, so neither item is
    // recommended; a stray row for one must not inflate the prompt.
    mockGetEvidenceStatuses.mockResolvedValue({ va_rating_letter: 'collected', service_treatment_records: 'collected' })
    const { requestCoaching } = await import('./actions')

    await requestCoaching({ note: null }, new FormData())

    const input = mockExecute.mock.calls[0][2] as CoachingInput
    expect(input.collectedLabels).toEqual([])
  })

  test('score, band and topGap are the deterministic rubric result for the real context', async () => {
    const statuses = { dd214: 'collected', personal_statement: 'collected' } as const
    mockGetEvidenceStatuses.mockResolvedValue(statuses)
    const { requestCoaching } = await import('./actions')

    await requestCoaching({ note: null }, new FormData())

    const expected = scoreCase(recommendEvidence(CTX), statuses)
    const input = mockExecute.mock.calls[0][2] as CoachingInput
    expect(input.score).toBe(expected.score)
    expect(input.band).toBe(expected.band)
    expect(input.band).toBe('building')
    expect(input.topGapLabel).toBe(expected.topGap!.label)
    expect(input.topGapLabel).toBe(EVIDENCE_CATALOG.nexus_letter.label)
  })

  test('everything collected → band strong and topGapLabel null (not undefined)', async () => {
    const statuses = Object.fromEntries(recommendEvidence(CTX).map((i) => [i.type, 'collected']))
    mockGetEvidenceStatuses.mockResolvedValue(statuses)
    const { requestCoaching } = await import('./actions')

    await requestCoaching({ note: null }, new FormData())

    const input = mockExecute.mock.calls[0][2] as CoachingInput
    expect(input.score).toBe(100)
    expect(input.band).toBe('strong')
    expect(input.topGapLabel).toBeNull()
  })

  test('the prompt input carries exactly the four recomputed fields, nothing from the form', async () => {
    const { requestCoaching } = await import('./actions')
    const fd = new FormData()
    fd.set('collectedLabels', 'everything')

    await requestCoaching({ note: null }, fd)

    expect(Object.keys(mockExecute.mock.calls[0][2] as object).sort()).toEqual(
      ['band', 'collectedLabels', 'score', 'topGapLabel'],
    )
  })
})

describe('saveContext', () => {
  test('requires a session, asking to come back to the evidence page', async () => {
    mockRequireSessionUser.mockRejectedValueOnce(new Error('NEXT_REDIRECT:/login'))
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm())).rejects.toThrow('NEXT_REDIRECT:/login')
    expect(mockRequireSessionUser).toHaveBeenCalledWith('/case/evidence')
    expect(mockSaveCaseContext).not.toHaveBeenCalled()
  })

  test('happy path: saves owner-scoped, then returns to the evidence page clean', async () => {
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm({ conditionCategory: 'tbi' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(mockSaveCaseContext).toHaveBeenCalledWith('user-1', 'case-1', {
      conditionCategory: 'tbi',
      mstInvolved: false,
      treatedInService: false,
      hasVaRating: false,
    })
    expect(redirectSpy).toHaveBeenCalledTimes(1)
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence')
  })

  test('a category the schema refuses → invalid_context, nothing saved', async () => {
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm({ conditionCategory: 'starfleet' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence?error=invalid_context')
    expect(mockGetOrCreateCase).not.toHaveBeenCalled()
    expect(mockSaveCaseContext).not.toHaveBeenCalled()
  })

  test('a missing category is invalid_context too', async () => {
    const fd = new FormData()
    const { saveContext } = await import('./actions')

    await expect(saveContext(fd)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence?error=invalid_context')
  })

  test.each([
    ['mstInvolved'],
    ['treatedInService'],
    ['hasVaRating'],
  ])('checkbox %s: present as "on" → true', async (box) => {
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm({ [box]: 'on' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(mockSaveCaseContext).toHaveBeenCalledWith(
      'user-1', 'case-1', expect.objectContaining({ [box]: true }),
    )
  })

  test('checkboxes absent from the form → false (an unchecked box sends nothing)', async () => {
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm())).rejects.toThrow('NEXT_REDIRECT')
    expect(mockSaveCaseContext).toHaveBeenCalledWith('user-1', 'case-1', expect.objectContaining({
      mstInvolved: false,
      treatedInService: false,
      hasVaRating: false,
    }))
  })

  test('a checkbox sent as "true" is NOT a checked box — only the literal "on" counts', async () => {
    const { saveContext } = await import('./actions')

    await expect(
      saveContext(contextForm({ mstInvolved: 'true', treatedInService: '1', hasVaRating: 'ON' })),
    ).rejects.toThrow('NEXT_REDIRECT')
    expect(mockSaveCaseContext).toHaveBeenCalledWith('user-1', 'case-1', expect.objectContaining({
      mstInvolved: false,
      treatedInService: false,
      hasVaRating: false,
    }))
  })

  test('a failed save surfaces as save_failed, never as the thrown message', async () => {
    mockSaveCaseContext.mockRejectedValueOnce(new Error('case_context write affected no rows (owner mismatch)'))
    const { saveContext } = await import('./actions')

    await expect(saveContext(contextForm())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledTimes(1)
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence?error=save_failed')
  })
})

describe('setItemStatus', () => {
  test('the session is resolved BEFORE any input is looked at', async () => {
    // An anonymous caller with garbage input must be bounced by the session
    // check, not by validation — the validation redirect would tell them which
    // statuses and item types this app accepts.
    mockRequireSessionUser.mockRejectedValueOnce(new Error('NEXT_REDIRECT:/login'))
    const { setItemStatus } = await import('./actions')

    await expect(setItemStatus(statusForm('not_a_type', 'garbage'))).rejects.toThrow('NEXT_REDIRECT:/login')
    expect(mockRequireSessionUser).toHaveBeenCalledWith('/case/evidence')
    expect(redirectSpy).not.toHaveBeenCalled()
    expect(mockSetEvidenceStatus).not.toHaveBeenCalled()
  })

  test('signed in: the session call precedes the validation redirect in time', async () => {
    const { setItemStatus } = await import('./actions')

    await expect(setItemStatus(statusForm('dd214', 'garbage'))).rejects.toThrow('NEXT_REDIRECT')
    expect(mockRequireSessionUser.mock.invocationCallOrder[0])
      .toBeLessThan(redirectSpy.mock.invocationCallOrder[0])
  })

  test('a status outside the allow-list → silent return to the page, no DB write', async () => {
    const { setItemStatus } = await import('./actions')

    for (const bad of ['garbage', '', 'COLLECTED', 'collected ', 'deleted']) {
      redirectSpy.mockClear()
      await expect(setItemStatus(statusForm('dd214', bad)), bad).rejects.toThrow('NEXT_REDIRECT')
      expect(redirectSpy, bad).toHaveBeenCalledWith('/case/evidence')
    }
    expect(mockGetOrCreateCase).not.toHaveBeenCalled()
    expect(mockSetEvidenceStatus).not.toHaveBeenCalled()
  })

  test('an item type outside the catalog → same silent return, no DB write', async () => {
    const { setItemStatus } = await import('./actions')

    for (const bad of ['not_a_type', '', 'DD214', 'dd214 ']) {
      redirectSpy.mockClear()
      await expect(setItemStatus(statusForm(bad, 'collected')), bad).rejects.toThrow('NEXT_REDIRECT')
      expect(redirectSpy, bad).toHaveBeenCalledWith('/case/evidence')
    }
    expect(mockGetOrCreateCase).not.toHaveBeenCalled()
    expect(mockSetEvidenceStatus).not.toHaveBeenCalled()
  })

  test('the status is checked before the item type (both bad → still one redirect)', async () => {
    const { setItemStatus } = await import('./actions')

    await expect(setItemStatus(statusForm('not_a_type', 'garbage'))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledTimes(1)
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence')
  })

  test('a failed write surfaces as save_failed, never as the thrown message', async () => {
    mockSetEvidenceStatus.mockRejectedValueOnce(new Error('evidence_items write affected no rows (owner mismatch)'))
    const { setItemStatus } = await import('./actions')

    await expect(setItemStatus(statusForm('dd214', 'collected'))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/evidence?error=save_failed')
    expect(revalidateSpy).not.toHaveBeenCalled()
  })

  test('happy path: writes owner-scoped, revalidates the page, and does NOT redirect', async () => {
    const { setItemStatus } = await import('./actions')

    await expect(setItemStatus(statusForm('nexus_letter', 'requested'))).resolves.toBeUndefined()
    expect(mockSetEvidenceStatus).toHaveBeenCalledWith('user-1', 'case-1', 'nexus_letter', 'requested')
    expect(revalidateSpy).toHaveBeenCalledWith('/case/evidence')
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('every catalog item accepts every allowed status', async () => {
    const { setItemStatus } = await import('./actions')

    for (const itemType of Object.keys(EVIDENCE_CATALOG)) {
      for (const status of ['needed', 'requested', 'collected', 'not_applicable']) {
        await setItemStatus(statusForm(itemType, status))
      }
    }
    expect(redirectSpy).not.toHaveBeenCalled()
    expect(mockSetEvidenceStatus).toHaveBeenCalledTimes(Object.keys(EVIDENCE_CATALOG).length * 4)
  })
})
