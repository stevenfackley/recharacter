import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
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

const CASE = { id: 'case-1', owner_id: 'user-1' }
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
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockGetOrCreateCase.mockResolvedValue(CASE)
  mockGetServiceFacts.mockResolvedValue(FACTS)
  mockRouteDischarge.mockResolvedValue(ROUTING)
  mockGetDraft.mockImplementation(async (_caseId: string, kind: string) =>
    (kind === 'personal_statement' ? STATEMENT_DRAFT : COVER_LETTER_DRAFT))
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: async () => ({ data: [{ item_type: 'dd214', status: 'collected' }] }),
    }),
  }))
})

describe('GET /api/packet', () => {
  test('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await callRoute()
    expect(res.status).toBe(401)
  })

  test('409 when service facts are not confirmed', async () => {
    mockGetServiceFacts.mockResolvedValue({ ...FACTS, confirmed: false })
    const res = await callRoute()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBeTruthy()
    expect(mockRouteDischarge).not.toHaveBeenCalled()
  })

  test('409 when no personal-statement draft exists', async () => {
    mockGetDraft.mockImplementation(async (_caseId: string, kind: string) =>
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

  test('happy path succeeds without a cover-letter draft — the statement is the hard requirement', async () => {
    mockGetDraft.mockImplementation(async (_caseId: string, kind: string) =>
      (kind === 'personal_statement' ? STATEMENT_DRAFT : null))
    const res = await callRoute()
    expect(res.status).toBe(200)
  })
})
