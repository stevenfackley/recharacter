import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Transport contract for account deletion: confirm-gated, fails closed when
 * the admin client is unavailable, and never reports success (redirect to /)
 * unless the data actually went.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

const mockGetUser = vi.fn()
const signOutSpy = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser, signOut: signOutSpy },
  }),
}))

const mockCreateAdmin = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockCreateAdmin(),
}))

const mockDeleteAccountData = vi.fn()
vi.mock('@/lib/account', () => ({
  deleteAccountData: (...args: unknown[]) => mockDeleteAccountData(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockCreateAdmin.mockReturnValue({ kind: 'admin-client' })
  mockDeleteAccountData.mockResolvedValue(undefined)
})

function confirmedForm(confirmed: boolean) {
  const fd = new FormData()
  if (confirmed) fd.set('confirm', 'on')
  return fd
}

describe('deleteAccount', () => {
  test('happy path: deletes, signs out, lands on the public page', async () => {
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(confirmedForm(true))).rejects.toThrow()
    expect(mockDeleteAccountData).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', adminClient: { kind: 'admin-client' } }),
    )
    expect(signOutSpy).toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith('/')
  })

  test('without the confirmation checkbox nothing is deleted', async () => {
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(confirmedForm(false))).rejects.toThrow()
    expect(mockDeleteAccountData).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/settings/data?error='))
  })

  test('fails closed when the service-role client is unconfigured', async () => {
    mockCreateAdmin.mockReturnValue(null)
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(confirmedForm(true))).rejects.toThrow()
    expect(mockDeleteAccountData).not.toHaveBeenCalled()
    const target = decodeURIComponent(redirectSpy.mock.calls[0][0] as string)
    expect(target).toContain('nothing was removed')
  })

  test('a mid-flight failure reports an error, not success', async () => {
    mockDeleteAccountData.mockRejectedValue(new Error('storage down'))
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(confirmedForm(true))).rejects.toThrow()
    expect(signOutSpy).not.toHaveBeenCalled()
    expect(redirectSpy).toHaveBeenCalledWith(expect.stringContaining('/settings/data?error='))
    expect(redirectSpy).not.toHaveBeenCalledWith('/')
  })

  test('unauthenticated users are sent to login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const { deleteAccount } = await import('./actions')

    await expect(deleteAccount(confirmedForm(true))).rejects.toThrow()
    expect(redirectSpy).toHaveBeenCalledWith('/login')
    expect(mockDeleteAccountData).not.toHaveBeenCalled()
  })
})
