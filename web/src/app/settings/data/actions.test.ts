import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Transport contract for account deletion: confirm-gated, and it never lands on
 * the signed-out page unless the data actually went. Every failure exits with a
 * CODE rather than a message, because `?error=` is rendered back onto our own
 * page and attacker-chosen copy there is a phishing surface.
 *
 * What actually gets deleted is proven in tests/account-deletion.integration.test.ts.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

const mockRequireSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  requireSessionUser: (...args: unknown[]) => mockRequireSessionUser(...args),
}))

const mockDeleteAccountData = vi.fn()
class MockDeletionUnavailableError extends Error {}
vi.mock('@/lib/account', () => ({
  deleteAccountData: (...args: unknown[]) => mockDeleteAccountData(...args),
  DeletionUnavailableError: MockDeletionUnavailableError,
}))

const store = { kind: 'object-store' }
vi.mock('@/lib/storage', () => ({ getObjectStore: () => store }))

const signOutSpy = vi.fn()
vi.mock('@/auth', () => ({ signOut: (...args: unknown[]) => signOutSpy(...args) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockRequireSessionUser.mockResolvedValue({ id: 'owner-1', email: 'vet@example.test' })
  mockDeleteAccountData.mockResolvedValue({ rowsByTable: {}, objects: 0 })
})

function form(confirmed: boolean) {
  const fd = new FormData()
  if (confirmed) fd.set('confirm', 'on')
  return fd
}

describe('deleteAccount', () => {
  test('deletes, signs the session out, and lands on the signed-out login page', async () => {
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(form(true))).rejects.toThrow('NEXT_REDIRECT')

    expect(mockRequireSessionUser).toHaveBeenCalledWith('/settings/data')
    expect(mockDeleteAccountData).toHaveBeenCalledWith('owner-1', { store })
    expect(signOutSpy).toHaveBeenCalledWith({ redirect: false })
    expect(redirectSpy).toHaveBeenCalledWith('/login?deleted=1')
  })

  test('a failed sign-out does not turn a completed deletion into an error', async () => {
    signOutSpy.mockRejectedValue(new Error('cookie store unavailable'))
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(form(true))).rejects.toThrow('NEXT_REDIRECT')

    expect(mockDeleteAccountData).toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith('/login?deleted=1')
    expect(redirectSpy).not.toHaveBeenCalledWith('/settings/data?error=deletion_failed')
  })

  test('without the confirmation nothing is deleted', async () => {
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(form(false))).rejects.toThrow('NEXT_REDIRECT')

    expect(mockDeleteAccountData).not.toHaveBeenCalled()
    expect(signOutSpy).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith('/settings/data?error=confirm_phrase')
  })

  test('an unconfigured admin service account says so, and keeps the session', async () => {
    mockDeleteAccountData.mockRejectedValue(new MockDeletionUnavailableError('no secret'))
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(form(true))).rejects.toThrow('NEXT_REDIRECT')

    expect(redirectSpy).toHaveBeenCalledWith('/settings/data?error=deletion_unavailable')
    expect(signOutSpy).not.toHaveBeenCalled()
  })

  test('a mid-flight failure reports an error, not success', async () => {
    mockDeleteAccountData.mockRejectedValue(new Error('bucket unreachable'))
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(form(true))).rejects.toThrow('NEXT_REDIRECT')

    expect(redirectSpy).toHaveBeenCalledWith('/settings/data?error=deletion_failed')
    expect(redirectSpy).not.toHaveBeenCalledWith('/login?deleted=1')
    expect(signOutSpy).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      'account deletion failed',
      { ownerId: 'owner-1', message: 'bucket unreachable' },
    )
  })
})
