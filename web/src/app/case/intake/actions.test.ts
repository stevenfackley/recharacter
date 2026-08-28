import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Transport contract for the intake actions.
 *
 * Provenance through the confirm gate (launch-checklist §2) is now decided inside
 * lib/facts.ts and proven by resolveSource in src/lib/facts.test.ts; what this
 * file guards is what the ACTION does — that it hands the confirm gate the
 * owner-scoped call, that every failure exits with a CODE rather than a message
 * (`?error=` is rendered back onto our own page), and that the AI extraction is
 * told the SNIFFED content type rather than the client's Content-Type.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

vi.mock('@/lib/session', () => ({
  requireSessionUser: async () => ({ id: 'user-1', email: 'vet@example.test' }),
}))

vi.mock('@/lib/cases', () => ({
  getOrCreateCase: async () => ({ id: 'case-1' }),
}))

const mockExecute = vi.fn()
vi.mock('@/lib/ai/gateway', () => ({
  executeAiTask: (...args: unknown[]) => mockExecute(...args),
}))

const store = { kind: 'object-store' }
vi.mock('@/lib/storage', () => ({ getObjectStore: () => store }))

class MockDocumentTooLargeError extends Error {}
class MockUnsupportedDocumentError extends Error {}
const mockPutCaseDocument = vi.fn()
vi.mock('@/lib/case-documents', () => ({
  putCaseDocument: (...args: unknown[]) => mockPutCaseDocument(...args),
  DocumentTooLargeError: MockDocumentTooLargeError,
  UnsupportedDocumentError: MockUnsupportedDocumentError,
}))

const mockSaveServiceFacts = vi.fn()
const mockConfirmServiceFacts = vi.fn()
vi.mock('@/lib/facts', async (importOriginal) => {
  // The REAL schema — input validation is part of what these tests exercise.
  const actual = await importOriginal<typeof import('@/lib/facts')>()
  return {
    serviceFactsSchema: actual.serviceFactsSchema,
    saveServiceFacts: (...args: unknown[]) => mockSaveServiceFacts(...args),
    confirmServiceFacts: (...args: unknown[]) => mockConfirmServiceFacts(...args),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockPutCaseDocument.mockResolvedValue({ key: 'user-1/case-1/x.pdf', contentType: 'application/pdf' })
})

function confirmForm(over: Partial<Record<string, string>> = {}) {
  const fd = new FormData()
  fd.set('branch', over.branch ?? 'MarineCorps')
  fd.set('dischargeDate', over.dischargeDate ?? '2024-06-01')
  fd.set('characterization', over.characterization ?? 'OtherThanHonorable')
  // Checkbox semantics: present as 'on' when checked, absent otherwise.
  if (over.wasGeneralCourtMartial) fd.set('wasGeneralCourtMartial', over.wasGeneralCourtMartial)
  return fd
}

function uploadForm(file: File | null) {
  const fd = new FormData()
  if (file) fd.set('document', file)
  return fd
}

const PDF = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'dd214.pdf', {
  // Deliberately a LIE: the client's Content-Type must never reach the AI task.
  type: 'text/plain',
})

describe('confirmFacts — the human-confirmation gate', () => {
  test('hands the owner-scoped confirm gate the submitted facts, then returns to the case', async () => {
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm())).rejects.toThrow()
    expect(mockConfirmServiceFacts).toHaveBeenCalledWith('user-1', 'case-1', {
      branch: 'MarineCorps',
      dischargeDate: '2024-06-01',
      characterization: 'OtherThanHonorable',
      wasGeneralCourtMartial: false,
    })
    expect(redirectSpy).toHaveBeenCalledWith('/case')
  })

  test('a checked court-martial box is carried through as true', async () => {
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ wasGeneralCourtMartial: 'on' }))).rejects.toThrow()
    expect(mockConfirmServiceFacts).toHaveBeenCalledWith(
      'user-1', 'case-1', expect.objectContaining({ wasGeneralCourtMartial: true }),
    )
  })

  test('invalid input redirects back to intake with a CODE, without saving', async () => {
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm({ branch: 'Starfleet' }))).rejects.toThrow()
    expect(mockConfirmServiceFacts).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=invalid_facts')
  })

  test('a save failure surfaces as save_failed, never as the thrown message', async () => {
    mockConfirmServiceFacts.mockRejectedValueOnce(new Error('relation "service_facts" does not exist'))
    const { confirmFacts } = await import('./actions')

    await expect(confirmFacts(confirmForm())).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=save_failed')
  })
})

describe('uploadAndExtract — upload and extraction transport', () => {
  test('no file chosen redirects with no_file and never touches the store', async () => {
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(null))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=no_file')
    expect(mockPutCaseDocument).not.toHaveBeenCalled()
  })

  test('an empty file is treated as no file', async () => {
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(new File([], 'empty.pdf')))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=no_file')
    expect(mockPutCaseDocument).not.toHaveBeenCalled()
  })

  test('an oversized document redirects with file_too_large', async () => {
    mockPutCaseDocument.mockRejectedValueOnce(new MockDocumentTooLargeError('too big'))
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=file_too_large')
    expect(mockExecute).not.toHaveBeenCalled()
  })

  test('an unrecognized document redirects with unsupported_file', async () => {
    mockPutCaseDocument.mockRejectedValueOnce(new MockUnsupportedDocumentError('what is this'))
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=unsupported_file')
  })

  test('any other store failure redirects with upload_failed', async () => {
    mockPutCaseDocument.mockRejectedValueOnce(new Error('r2 unreachable'))
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=upload_failed')
  })

  test('the extraction task is told the SNIFFED type, never the client Content-Type', async () => {
    mockExecute.mockResolvedValue({ ok: false, status: 502, error: 'AI provider error' })
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    const [ownerId, task, input] = mockExecute.mock.calls[0] as [string, string, { mediaType: string }]
    expect(ownerId).toBe('user-1')
    expect(task).toBe('extract_service_facts')
    expect(input.mediaType).toBe('application/pdf')
  })

  test('a rejected BYOK key is its own code — a retry can never fix it', async () => {
    mockExecute.mockResolvedValue({
      ok: false, status: 502, error: 'rejected', byokKeyRejected: true,
    })
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?error=byok_key_rejected')
  })

  test('a complete extraction is saved UNCONFIRMED as extracted, then reviewed', async () => {
    mockExecute.mockResolvedValue({
      ok: true,
      data: {
        branch: 'MarineCorps', dischargeDate: '2024-06-01',
        characterization: 'OtherThanHonorable', wasGeneralCourtMartial: false,
      },
    })
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(mockSaveServiceFacts).toHaveBeenCalledWith(
      'user-1', 'case-1',
      expect.objectContaining({ branch: 'MarineCorps' }),
      'extracted',
    )
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?extracted=1')
  })

  test('a PARTIAL extraction saves nothing and forwards no personal data in the URL', async () => {
    mockExecute.mockResolvedValue({
      ok: true,
      data: {
        branch: null, dischargeDate: '2024-06-01',
        characterization: 'OtherThanHonorable', wasGeneralCourtMartial: null,
      },
    })
    const { uploadAndExtract } = await import('./actions')

    await expect(uploadAndExtract(uploadForm(PDF()))).rejects.toThrow()
    expect(mockSaveServiceFacts).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith('/case/intake?partial=1')
  })
})
