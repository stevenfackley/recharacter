import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockGetSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: () => mockGetSessionUser(),
}))

const mockIsEntitled = vi.fn()
vi.mock('@/lib/billing', () => ({
  isEntitled: (...args: unknown[]) => mockIsEntitled(...args),
}))

const mockGetOrCreateCase = vi.fn()
vi.mock('@/lib/cases', () => ({
  getOrCreateCase: (...args: unknown[]) => mockGetOrCreateCase(...args),
}))

const mockGetServiceFacts = vi.fn()
vi.mock('@/lib/facts', () => ({
  getServiceFacts: (...args: unknown[]) => mockGetServiceFacts(...args),
}))

const mockRouteDischarge = vi.fn()
vi.mock('@/lib/routing', () => ({
  routeDischarge: (...args: unknown[]) => mockRouteDischarge(...args),
}))

const mockGetDraft = vi.fn()
vi.mock('@/lib/drafts', () => ({
  getDraft: (...args: unknown[]) => mockGetDraft(...args),
}))

const mockGetEvidenceStatuses = vi.fn()
vi.mock('@/lib/evidence-items', () => ({
  getEvidenceStatuses: (...args: unknown[]) => mockGetEvidenceStatuses(...args),
}))

// Delegates to the real renderPacket by default so the existing happy-path
// assertions (real %PDF bytes) still hold; only the "render throws" test
// below overrides this with a rejection.
const mockRenderPacket = vi.fn()
vi.mock('@/lib/packet/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/packet/render')>()
  mockRenderPacket.mockImplementation(actual.renderPacket)
  return { renderPacket: (...args: Parameters<typeof actual.renderPacket>) => mockRenderPacket(...args) }
})

const CASE = { id: 'case-1' }
const FACTS = {
  id: 'facts-1',
  case_id: 'case-1',
  branch: 'MarineCorps',
  dischargeDate: '2015-04-01',
  characterization: 'OtherThanHonorable',
  wasGeneralCourtMartial: false,
  source: 'manual',
  confirmed: true,
}
const ROUTING = {
  recommendedBoard: 'Drb',
  recommendedForm: 'DD293',
  boardName: 'NDRB',
  availableBoards: ['Drb', 'Bcmr'],
  drbDeadline: '2030-04-01',
  drbWindowOpen: true,
  flags: [],
}
const STATEMENT_DRAFT = {
  kind: 'personal_statement', content: 'My statement text.', edited: false, generated_at: '2026-01-01',
}
const COVER_LETTER_DRAFT = {
  kind: 'cover_letter', content: 'My cover letter text.', edited: false, generated_at: '2026-01-01',
}

async function callRoute() {
  const { GET } = await import('@/app/api/packet/route')
  return GET()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockGetSessionUser.mockResolvedValue({ id: 'user-1', email: null })
  // Default: entitled, so the assertions below are unaffected by the gate.
  mockIsEntitled.mockResolvedValue(true)
  mockGetOrCreateCase.mockResolvedValue(CASE)
  mockGetServiceFacts.mockResolvedValue(FACTS)
  mockRouteDischarge.mockResolvedValue(ROUTING)
  mockGetDraft.mockImplementation(async (_ownerId: string, _caseId: string, kind: string) =>
    (kind === 'personal_statement' ? STATEMENT_DRAFT : COVER_LETTER_DRAFT))
  mockGetEvidenceStatuses.mockResolvedValue({ dd214: 'collected' })
})

describe('GET /api/packet', () => {
  test('401 when unauthenticated', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRoute()
    expect(res.status).toBe(401)
    expect(mockIsEntitled).not.toHaveBeenCalled()
  })

  test('409 when service facts are not confirmed', async () => {
    mockGetServiceFacts.mockResolvedValue({ ...FACTS, confirmed: false })
    const res = await callRoute()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBeTruthy()
    expect(mockRouteDischarge).not.toHaveBeenCalled()
  })

  test('409 when no personal-statement draft exists', async () => {
    mockGetDraft.mockImplementation(async (_ownerId: string, _caseId: string, kind: string) =>
      (kind === 'personal_statement' ? null : COVER_LETTER_DRAFT))
    const res = await callRoute()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBeTruthy()
  })

  test('503 when the routing service is unavailable', async () => {
    mockRouteDischarge.mockRejectedValue(new Error('routing down'))
    const res = await callRoute()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBeTruthy()
  })

  test('happy path: 200 application/pdf, filename in content-disposition, body starts with %PDF', async () => {
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('recharacter-packet.pdf')

    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.subarray(0, 4).toString('utf-8')).toBe('%PDF')
  })

  test('every read is owner-scoped — the session id is the first argument', async () => {
    await callRoute()
    expect(mockIsEntitled).toHaveBeenCalledWith('user-1')
    expect(mockGetOrCreateCase).toHaveBeenCalledWith('user-1')
    expect(mockGetServiceFacts).toHaveBeenCalledWith('user-1', 'case-1')
    expect(mockGetEvidenceStatuses).toHaveBeenCalledWith('user-1', 'case-1')
    expect(mockGetDraft).toHaveBeenCalledWith('user-1', 'case-1', 'personal_statement')
  })

  test('the packet is never cached by a shared cache, and varies on the session cookie', async () => {
    const res = await callRoute()
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('vary')).toContain('Cookie')
  })

  test('the no-store headers are on the refusals too, not only the PDF', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await callRoute()
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('vary')).toContain('Cookie')
  })

  test('happy path succeeds without a cover-letter draft — the statement is the hard requirement', async () => {
    mockGetDraft.mockImplementation(async (_ownerId: string, _caseId: string, kind: string) =>
      (kind === 'personal_statement' ? STATEMENT_DRAFT : null))
    const res = await callRoute()
    expect(res.status).toBe(200)
  })

  test('402 when the user has no paid unlock and no BYOK key', async () => {
    mockIsEntitled.mockResolvedValue(false)
    const res = await callRoute()
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(body.upgrade).toBe('/case/upgrade')
    expect(mockRouteDischarge).not.toHaveBeenCalled()
  })

  test('500 with a packet_render_failed JSON body when renderPacket throws (e.g. non-WinAnsi text), not an unhandled rejection', async () => {
    mockRenderPacket.mockRejectedValueOnce(new Error('WinAnsi cannot encode "🚀" (0x1f680)'))
    const res = await callRoute()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('packet_render_failed')
  })
})
