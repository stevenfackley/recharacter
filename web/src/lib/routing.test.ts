import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { routeDischarge } from '@/lib/routing'

const RESULT = {
  recommendedBoard: 'Drb',
  recommendedForm: 'DD293',
  boardName: 'NDRB',
  availableBoards: ['Drb', 'Bcmr'],
  drbDeadline: '2039-06-01',
  drbWindowOpen: true,
  flags: [],
}

beforeEach(() => {
  process.env.ROUTING_API_URL = 'http://routing.test'
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('routeDischarge', () => {
  test('POSTs facts and returns the parsed RoutingResult', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(RESULT), { status: 200 }),
    )
    const result = await routeDischarge({
      branch: 'MarineCorps',
      dischargeDate: '2024-06-01',
      characterization: 'OtherThanHonorable',
      wasGeneralCourtMartial: false,
    })
    expect(result.recommendedBoard).toBe('Drb')
    expect(result.boardName).toBe('NDRB')

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('http://routing.test/route')
    expect(JSON.parse(String(init!.body)).branch).toBe('MarineCorps')
  })

  test('throws on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 500 }))
    await expect(routeDischarge({
      branch: 'Army', dischargeDate: '2020-01-01',
      characterization: 'Honorable', wasGeneralCourtMartial: false,
    })).rejects.toThrow(/routing service/i)
  })
})
