import { beforeEach, describe, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'

const mockSessionsCreate = vi.fn()
const mockSessionsRetrieve = vi.fn()
vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: mockSessionsCreate, retrieve: mockSessionsRetrieve } }
  },
}))

const mockRecordPendingCheckout = vi.fn()
const mockGrantEntitlement = vi.fn()
const mockListPendingCheckouts = vi.fn()
vi.mock('@/lib/billing', () => ({
  recordPendingCheckout: (...args: unknown[]) => mockRecordPendingCheckout(...args),
  grantEntitlement: (...args: unknown[]) => mockGrantEntitlement(...args),
  listPendingCheckouts: (...args: unknown[]) => mockListPendingCheckouts(...args),
}))

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const mockGetSessionUser = vi.fn()
const mockRequireSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: () => mockGetSessionUser(),
  requireSessionUser: (...args: unknown[]) => mockRequireSessionUser(...args),
}))

const USER = { id: 'user-1', email: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  process.env.STRIPE_PRICE_ID = 'price_fake123'
  process.env.APP_BASE_URL = 'http://localhost:3000'
  resetEnvForTests()
  mockGetSessionUser.mockResolvedValue(USER)
  mockRequireSessionUser.mockResolvedValue(USER)
  mockGrantEntitlement.mockResolvedValue('granted')
  mockListPendingCheckouts.mockResolvedValue([])
})

describe('startCheckout', () => {
  test('unauthenticated users are sent to login', async () => {
    mockRequireSessionUser.mockImplementation(async (next?: string) => {
      redirectSpy(`/login?next=${encodeURIComponent(next ?? '')}`)
      throw new Error('NEXT_REDIRECT')
    })
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/login?next=%2Fcase%2Fupgrade')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly CODE when Stripe is not configured (no live key needed for tests)', async () => {
    delete process.env.STRIPE_SECRET_KEY
    resetEnvForTests()
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=not_configured')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly CODE when STRIPE_PRICE_ID is missing', async () => {
    delete process.env.STRIPE_PRICE_ID
    resetEnvForTests()
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=not_configured')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('happy path: creates the session, records the pending checkout, redirects to session.url', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/pay/cs_test_abc' })
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()

    const createArgs = mockSessionsCreate.mock.calls[0][0]
    expect(createArgs.mode).toBe('payment')
    expect(createArgs.client_reference_id).toBe('user-1')
    expect(createArgs.line_items).toEqual([{ price: 'price_fake123', quantity: 1 }])

    expect(mockRecordPendingCheckout).toHaveBeenCalledWith('user-1', 'cs_test_abc')
    expect(redirectSpy).toHaveBeenCalledWith('https://checkout.stripe.com/pay/cs_test_abc')
  })

  test('a session with no hosted URL exits as checkout_failed', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_abc', url: null })
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=checkout_failed')
  })
})

describe('verifySession — the security-critical checks', () => {
  test('refuses when unauthenticated', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('refuses an unpaid session', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'unpaid', client_reference_id: 'user-1' })
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('refuses a session whose client_reference_id belongs to a different user', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: 'someone-else' })
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('refuses a fabricated or expired session id (Stripe retrieve throws) — fails closed', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('No such checkout.session: cs_fake'))
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_fake')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('grants the entitlement for a paid session belonging to the signed-in user', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: 'user-1' })
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(true)
    expect(mockGrantEntitlement).toHaveBeenCalledWith('user-1', 'cs_test_1')
  })

  test('an already-held entitlement is success, not a failed purchase', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: 'user-1' })
    mockGrantEntitlement.mockResolvedValue('already_entitled')
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(true)
  })

  test('a session id belonging to another owner fails closed rather than granting', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: 'user-1' })
    mockGrantEntitlement.mockRejectedValue(new Error('could not be granted'))
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
  })

  test('returns false (not throws) when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    resetEnvForTests()
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })
})

describe('restorePurchase', () => {
  test('verifies every pending checkout and reports granted when any succeed', async () => {
    mockListPendingCheckouts.mockResolvedValue(['cs_old', 'cs_new'])
    mockSessionsRetrieve.mockImplementation(async (id: string) => (
      id === 'cs_new'
        ? { payment_status: 'paid', client_reference_id: 'user-1' }
        : { payment_status: 'unpaid', client_reference_id: 'user-1' }
    ))
    const { restorePurchase } = await import('./actions')

    const result = await restorePurchase()
    expect(result).toEqual({ granted: true })
    expect(mockGrantEntitlement).toHaveBeenCalledTimes(1)
    expect(mockGrantEntitlement).toHaveBeenCalledWith('user-1', 'cs_new')
  })

  test('reports not granted when there are no pending checkouts', async () => {
    mockListPendingCheckouts.mockResolvedValue([])
    const { restorePurchase } = await import('./actions')

    expect(await restorePurchase()).toEqual({ granted: false })
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('the Stripe fan-out is capped — one button press is not an unbounded call storm', async () => {
    mockListPendingCheckouts.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => `cs_${i}`),
    )
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'unpaid', client_reference_id: 'user-1' })
    const { restorePurchase } = await import('./actions')

    expect(await restorePurchase()).toEqual({ granted: false })
    expect(mockSessionsRetrieve).toHaveBeenCalledTimes(5)
  })

  test('pending checkouts are read owner-scoped', async () => {
    const { restorePurchase } = await import('./actions')
    await restorePurchase()
    expect(mockListPendingCheckouts).toHaveBeenCalledWith('user-1')
  })
})
