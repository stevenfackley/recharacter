import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The export body is the veteran's entire record. Two things are load-bearing:
 * it is assembled for the SIGNED-IN owner only, and it never lands in a cache
 * that another request could be served from.
 */

const mockGetSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: () => mockGetSessionUser(),
}))

const store = { kind: 'object-store' }
vi.mock('@/lib/storage', () => ({ getObjectStore: () => store }))

const mockCollectExport = vi.fn()
vi.mock('@/lib/account', () => ({
  collectExport: (...args: unknown[]) => mockCollectExport(...args),
}))

const EXPORT = {
  exportedAt: '2026-01-01T00:00:00.000Z',
  ownerId: 'user-1',
  case: { id: 'case-1' },
  uploadedDocuments: ['user-1/case-1/dd214.pdf'],
}

async function callRoute() {
  const { GET } = await import('@/app/api/account/export/route')
  return GET()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSessionUser.mockResolvedValue({ id: 'user-1', email: 'vet@example.test' })
  mockCollectExport.mockResolvedValue(EXPORT)
})

describe('GET /api/account/export', () => {
  test('401 when there is no session, and nothing is assembled', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRoute()

    expect(res.status).toBe(401)
    expect(mockCollectExport).not.toHaveBeenCalled()
  })

  test('assembles the export for the signed-in owner, through the object store', async () => {
    const res = await callRoute()

    expect(res.status).toBe(200)
    expect(mockCollectExport).toHaveBeenCalledWith('user-1', store)
    expect(await res.json()).toEqual(EXPORT)
  })

  test('downloads as a file rather than rendering in the tab', async () => {
    const res = await callRoute()

    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-disposition')).toContain('recharacter-export.json')
  })

  test('never cached, and varies on the session cookie', async () => {
    const res = await callRoute()

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('vary')).toContain('Cookie')
  })

  test('the refusal carries the same no-store headers as the export itself', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRoute()

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('vary')).toContain('Cookie')
  })
})
