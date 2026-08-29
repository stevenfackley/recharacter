import { beforeEach, describe, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'

/**
 * Only the two real form actions live in the 'use server' module — everything
 * exported from one is a public RPC endpoint. The verification itself is tested
 * in src/lib/billing-verify.test.ts; what matters here is that these two resolve
 * the session BEFORE reaching it, and that a refused checkout exits with a code.
 */

const mockSessionsCreate = vi.fn()
vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: mockSessionsCreate, retrieve: vi.fn() } }
  },
}))

const mockRecordPendingCheckout = vi.fn()
vi.mock('@/lib/billing', () => ({
  recordPendingCheckout: (...args: unknown[]) => mockRecordPendingCheckout(...args),
}))

const mockRestorePurchase = vi.fn()
vi.mock('@/lib/billing-verify', async (importOriginal) => {
  // getStripeClient is the real one — the "not configured" paths depend on it.
  const actual = await importOriginal<typeof import('@/lib/billing-verify')>()
  return {
    getStripeClient: actual.getStripeClient,
    restorePurchase: (...args: unknown[]) => mockRestorePurchase(...args),
  }
})

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))
const revalidateSpy = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidateSpy(...args) }))

const mockRequireSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  requireSessionUser: (...args: unknown[]) => mockRequireSessionUser(...args),
}))

const USER = { id: 'user-1', email: null }

/** What requireSessionUser does for real when there is no session. */
function unauthenticated() {
  mockRequireSessionUser.mockImplementation(async (next?: string) => {
    redirectSpy(`/login?next=${encodeURIComponent(next ?? '')}`)
    throw new Error('NEXT_REDIRECT')
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  process.env.STRIPE_PRICE_ID = 'price_fake123'
  process.env.APP_BASE_URL = 'http://localhost:3000'
  resetEnvForTests()
  mockRequireSessionUser.mockResolvedValue(USER)
  mockRestorePurchase.mockResolvedValue({ granted: false })
})

describe('startCheckout', () => {
  test('unauthenticated users are sent to login', async () => {
    unauthenticated()
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/login?next=%2Fcase%2Fupgrade')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly CODE when Stripe is not configured (no live key needed for tests)', async () => {
    delete process.env.STRIPE_SECRET_KEY
    resetEnvForTests()
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=not_configured')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('friendly CODE when STRIPE_PRICE_ID is missing', async () => {
    delete process.env.STRIPE_PRICE_ID
    resetEnvForTests()
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=not_configured')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  test('happy path: creates the session, records the pending checkout, redirects to session.url', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/pay/cs_test_abc' })
    const { startCheckout } = await import('./actions')

    await expect(startCheckout()).rejects.toThrow('NEXT_REDIRECT')

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

    await expect(startCheckout()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/case/upgrade?error=checkout_failed')
  })
})

describe('restorePurchaseAction', () => {
  test('restores for the SIGNED-IN owner — the caller never names one', async () => {
    const { restorePurchaseAction } = await import('./actions')

    await restorePurchaseAction()
    expect(mockRestorePurchase).toHaveBeenCalledWith('user-1')
  })

  test('unauthenticated users are sent to login without any Stripe traffic', async () => {
    unauthenticated()
    const { restorePurchaseAction } = await import('./actions')

    await expect(restorePurchaseAction()).rejects.toThrow('NEXT_REDIRECT')
    expect(mockRestorePurchase).not.toHaveBeenCalled()
  })

  test('a successful restore revalidates the page so the unlock shows', async () => {
    mockRestorePurchase.mockResolvedValue({ granted: true })
    const { restorePurchaseAction } = await import('./actions')

    await restorePurchaseAction()
    expect(revalidateSpy).toHaveBeenCalledWith('/case/upgrade')
  })

  test('nothing to restore leaves the page as it is', async () => {
    const { restorePurchaseAction } = await import('./actions')

    await restorePurchaseAction()
    expect(revalidateSpy).not.toHaveBeenCalled()
  })
})
