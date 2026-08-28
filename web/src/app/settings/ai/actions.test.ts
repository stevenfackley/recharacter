import { beforeEach, describe, expect, test, vi } from 'vitest'
import { resetEnvForTests } from '@/lib/env'

/**
 * BYOK key handling. Two things are under test and the second is the one that
 * matters: every failure leaves as a CODE rather than a thrown Error (which
 * reached the veteran as a blank error boundary), and the key itself never
 * appears in a log line, a URL, or an error — only its ciphertext is passed on.
 */

const redirectSpy = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectSpy(...args)
    throw new Error('NEXT_REDIRECT')
  },
}))

const revalidateSpy = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidateSpy(...args) }))

vi.mock('@/lib/session', () => ({
  requireSessionUser: async () => ({ id: 'user-1', email: null }),
}))

const mockEncryptSecret = vi.fn()
vi.mock('@/lib/ai/crypto', () => ({
  encryptSecret: (...args: unknown[]) => mockEncryptSecret(...args),
}))

const mockSaveEncryptedKey = vi.fn()
const mockDeleteEncryptedKey = vi.fn()
vi.mock('@/lib/ai/credentials', () => ({
  saveEncryptedKey: (...args: unknown[]) => mockSaveEncryptedKey(...args),
  deleteEncryptedKey: (...args: unknown[]) => mockDeleteEncryptedKey(...args),
}))

const KEK = Buffer.alloc(32).toString('base64')
const KEY = 'sk-ant-api03-super-secret-value'

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.AI_KEY_ENCRYPTION_SECRET = KEK
  resetEnvForTests()
  mockEncryptSecret.mockReturnValue('ciphertext')
})

function keyForm(key: string) {
  const fd = new FormData()
  fd.set('apiKey', key)
  return fd
}

/** Every argument of every console call, flattened to one searchable string. */
function loggedText() {
  return (errorSpy.mock.calls.flat() as unknown[])
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' | ')
}

describe('saveByokKey', () => {
  test('encrypts under the owner id and stores only the ciphertext', async () => {
    const { saveByokKey } = await import('./actions')

    await saveByokKey(keyForm(KEY))

    expect(mockEncryptSecret).toHaveBeenCalledWith(KEY, KEK, 'user-1')
    expect(mockSaveEncryptedKey).toHaveBeenCalledWith('user-1', 'ciphertext')
    expect(revalidateSpy).toHaveBeenCalledWith('/settings/ai')
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('an empty key is refused before anything is encrypted', async () => {
    const { saveByokKey } = await import('./actions')

    await expect(saveByokKey(keyForm('   '))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/settings/ai?error=invalid_key')
    expect(mockEncryptSecret).not.toHaveBeenCalled()
  })

  test('a value that is not shaped like an Anthropic key is refused', async () => {
    const { saveByokKey } = await import('./actions')

    await expect(saveByokKey(keyForm('hunter2'))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/settings/ai?error=invalid_key')
    expect(mockSaveEncryptedKey).not.toHaveBeenCalled()
  })

  test('kek_missing when AI_KEY_ENCRYPTION_SECRET is unset — our fault, said as ours', async () => {
    delete process.env.AI_KEY_ENCRYPTION_SECRET
    resetEnvForTests()
    const { saveByokKey } = await import('./actions')

    await expect(saveByokKey(keyForm(KEY))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/settings/ai?error=kek_missing')
    expect(mockSaveEncryptedKey).not.toHaveBeenCalled()
  })

  test('save_failed when the credential store throws, never the raw Error', async () => {
    mockSaveEncryptedKey.mockRejectedValueOnce(new Error('relation "ai_credentials" does not exist'))
    const { saveByokKey } = await import('./actions')

    await expect(saveByokKey(keyForm(KEY))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/settings/ai?error=save_failed')
  })

  test('the plaintext key never reaches a log line, on any path', async () => {
    mockSaveEncryptedKey.mockRejectedValueOnce(new Error(`upstream rejected ${KEY}`))
    const { saveByokKey } = await import('./actions')

    await expect(saveByokKey(keyForm(KEY))).rejects.toThrow('NEXT_REDIRECT')
    // The action logs its own message, not the key and not the form.
    expect(loggedText()).not.toContain(KEY)
    expect(loggedText()).not.toContain('sk-ant-')
    // And the code it redirects with carries nothing of the key either.
    expect(String(redirectSpy.mock.calls[0][0])).not.toContain('sk-ant-')
  })
})

describe('removeByokKey', () => {
  test('deletes the signed-in owner’s credential and refreshes the page', async () => {
    const { removeByokKey } = await import('./actions')

    await removeByokKey()

    expect(mockDeleteEncryptedKey).toHaveBeenCalledWith('user-1')
    expect(revalidateSpy).toHaveBeenCalledWith('/settings/ai')
    expect(redirectSpy).not.toHaveBeenCalled()
  })

  test('remove_failed when the delete throws', async () => {
    mockDeleteEncryptedKey.mockRejectedValueOnce(new Error('connection terminated'))
    const { removeByokKey } = await import('./actions')

    await expect(removeByokKey()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectSpy).toHaveBeenCalledWith('/settings/ai?error=remove_failed')
  })
})
