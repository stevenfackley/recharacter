import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockSessionsCreate = vi.fn()
const mockSessionsRetrieve = vi.fn()
vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: mockSessionsCreate, retrieve: mockSessionsRetrieve } }
  },
}))

const mockRecordPendingCheckout = vi.fn()
const mockGrantEntitlement = vi.fn()
vi.mock('@/lib/billing', () => ({
  recordPendingCheckout: (...args: unknown[]) => mockRecordPendingCheckout(...args),
  grantEntitlement: (...args: unknown[]) => mockGrantEntitlement(...args),
}))

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  process.env.STRIPE_PRICE_ID = 'price_fake123'
  process.env.APP_BASE_URL = 'http://localhost:3000'
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
})

describe('startCheckout', () => {
  test('unauthenticated users are sent to login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/login')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly redirect when Stripe is not configured (no live key needed for tests)', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/case/upgrade?error='))
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly redirect when STRIPE_PRICE_ID is missing', async () => {
    delete process.env.STRIPE_PRICE_ID
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/case/upgrade?error='))
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

    expect(mockRecordPendingCheckout).toHaveBeenCalledWith('cs_test_abc')
    expect(redirectSpy).toHaveBeenCalledWith('https://checkout.stripe.com/pay/cs_test_abc')
  })
})

describe('verifySession — the security-critical checks', () => {
  test('refuses when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
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
    expect(mockGrantEntitlement).toHaveBeenCalledWith('cs_test_1')
  })

  test('returns false (not throws) when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const { verifySession } = await import('./actions')

    expect(await verifySession('cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })
})

describe('restorePurchase', () => {
  test('verifies every pending checkout and reports granted when any succeed', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: async () => ({ data: [{ stripe_session_id: 'cs_old' }, { stripe_session_id: 'cs_new' }] }),
      }),
    }))
    mockSessionsRetrieve.mockImplementation(async (id: string) => (
      id === 'cs_new'
        ? { payment_status: 'paid', client_reference_id: 'user-1' }
        : { payment_status: 'unpaid', client_reference_id: 'user-1' }
    ))
    const { restorePurchase } = await import('./actions')

    const result = await restorePurchase()
    expect(result).toEqual({ granted: true })
    expect(mockGrantEntitlement).toHaveBeenCalledTimes(1)
    expect(mockGrantEntitlement).toHaveBeenCalledWith('cs_new')
  })

  test('reports not granted when there are no pending checkouts', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({ eq: async () => ({ data: [] }) }),
    }))
    const { restorePurchase } = await import('./actions')

    expect(await restorePurchase()).toEqual({ granted: false })
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })
})
