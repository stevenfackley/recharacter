import { beforeEach, describe, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'

/**
 * The fail-closed checks behind the case unlock. These live outside the
 * 'use server' module on purpose — as exported actions they would be a public
 * RPC surface where the caller picks both the session id and the owner it is
 * checked against, and restorePurchase's Stripe loop would have no cap at all.
 */

const mockSessionsRetrieve = vi.fn()
vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { retrieve: mockSessionsRetrieve } }
  },
}))

const mockGrantEntitlement = vi.fn()
const mockListPendingCheckouts = vi.fn()
vi.mock('@/lib/billing', () => ({
  grantEntitlement: (...args: unknown[]) => mockGrantEntitlement(...args),
  listPendingCheckouts: (...args: unknown[]) => mockListPendingCheckouts(...args),
}))

const OWNER = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  resetEnvForTests()
  mockGrantEntitlement.mockResolvedValue('granted')
  mockListPendingCheckouts.mockResolvedValue([])
})

describe('verifySession — the security-critical checks', () => {
  test('refuses an unpaid session', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'unpaid', client_reference_id: OWNER })
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('refuses a session whose client_reference_id belongs to a different user', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: 'someone-else' })
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('refuses a fabricated or expired session id (Stripe retrieve throws) — fails closed', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('No such checkout.session: cs_fake'))
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_fake')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('returns false (not throws) when Stripe is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    resetEnvForTests()
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(false)
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('grants the entitlement for a paid session belonging to the asking owner', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: OWNER })
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(true)
    expect(mockGrantEntitlement).toHaveBeenCalledWith(OWNER, 'cs_test_1')
  })

  test('an already-held entitlement is success, not a failed purchase', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: OWNER })
    mockGrantEntitlement.mockResolvedValue('already_entitled')
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(true)
  })

  test('a session id already spent by another owner fails closed rather than granting', async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'paid', client_reference_id: OWNER })
    mockGrantEntitlement.mockRejectedValue(new Error('could not be granted'))
    const { verifySession } = await import('./billing-verify')

    expect(await verifySession(OWNER, 'cs_test_1')).toBe(false)
  })
})

describe('restorePurchase', () => {
  test('verifies every pending checkout and reports granted when any succeed', async () => {
    mockListPendingCheckouts.mockResolvedValue(['cs_old', 'cs_new'])
    mockSessionsRetrieve.mockImplementation(async (id: string) => (
      id === 'cs_new'
        ? { payment_status: 'paid', client_reference_id: OWNER }
        : { payment_status: 'unpaid', client_reference_id: OWNER }
    ))
    const { restorePurchase } = await import('./billing-verify')

    expect(await restorePurchase(OWNER)).toEqual({ granted: true })
    expect(mockGrantEntitlement).toHaveBeenCalledTimes(1)
    expect(mockGrantEntitlement).toHaveBeenCalledWith(OWNER, 'cs_new')
  })

  test('reports not granted when there are no pending checkouts', async () => {
    mockListPendingCheckouts.mockResolvedValue([])
    const { restorePurchase } = await import('./billing-verify')

    expect(await restorePurchase(OWNER)).toEqual({ granted: false })
    expect(mockGrantEntitlement).not.toHaveBeenCalled()
  })

  test('the Stripe fan-out is capped — one restore is not an unbounded call storm', async () => {
    mockListPendingCheckouts.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `cs_${i}`))
    mockSessionsRetrieve.mockResolvedValue({ payment_status: 'unpaid', client_reference_id: OWNER })
    const { restorePurchase } = await import('./billing-verify')

    expect(await restorePurchase(OWNER)).toEqual({ granted: false })
    expect(mockSessionsRetrieve).toHaveBeenCalledTimes(5)
  })

  test('pending checkouts are read owner-scoped', async () => {
    const { restorePurchase } = await import('./billing-verify')
    await restorePurchase(OWNER)
    expect(mockListPendingCheckouts).toHaveBeenCalledWith(OWNER)
  })
})
