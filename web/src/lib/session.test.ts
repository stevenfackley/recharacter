import { beforeEach, describe, expect, test, vi } from 'vitest'

const auth = vi.fn()
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})

vi.mock('@/auth', () => ({ auth }))
vi.mock('next/navigation', () => ({ redirect }))

const { getSessionUser, requireSessionUser, safeNext } = await import('./session')

const SUB = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

beforeEach(() => {
  auth.mockReset()
  redirect.mockClear()
})

describe('getSessionUser', () => {
  test('returns the keycloak sub and email', async () => {
    auth.mockResolvedValue({ user: { id: SUB, email: 'vet@example.test' } })

    await expect(getSessionUser()).resolves.toEqual({ id: SUB, email: 'vet@example.test' })
  })

  test('a session with no email still yields a user', async () => {
    auth.mockResolvedValue({ user: { id: SUB } })

    await expect(getSessionUser()).resolves.toEqual({ id: SUB, email: null })
  })

  test('no session is no user', async () => {
    auth.mockResolvedValue(null)
    await expect(getSessionUser()).resolves.toBeNull()

    auth.mockResolvedValue({ user: undefined })
    await expect(getSessionUser()).resolves.toBeNull()
  })

  test('an id that is not a keycloak sub is refused', async () => {
    // `id` becomes owner_id on every row the user owns. An email or a provider
    // login name reaching that column would silently widen row ownership, so
    // anything but a UUID is treated as no session at all.
    for (const id of ['vet@example.test', '', 'undefined', '../../etc/passwd', SUB.slice(0, -1)]) {
      auth.mockResolvedValue({ user: { id, email: 'vet@example.test' } })
      await expect(getSessionUser()).resolves.toBeNull()
    }
  })
})

describe('requireSessionUser', () => {
  test('returns the user when signed in', async () => {
    auth.mockResolvedValue({ user: { id: SUB, email: 'vet@example.test' } })

    await expect(requireSessionUser('/case/nexus')).resolves.toEqual({
      id: SUB,
      email: 'vet@example.test',
    })
    expect(redirect).not.toHaveBeenCalled()
  })

  test('redirects to login carrying the return-to path', async () => {
    auth.mockResolvedValue(null)

    await expect(requireSessionUser('/case/nexus?x=1')).rejects.toThrow(
      'REDIRECT:/login?next=%2Fcase%2Fnexus%3Fx%3D1',
    )
  })

  test('redirects to a bare login when there is nothing to return to', async () => {
    auth.mockResolvedValue(null)

    await expect(requireSessionUser()).rejects.toThrow('REDIRECT:/login')
  })
})

describe('safeNext', () => {
  test('keeps same-origin absolute paths', () => {
    expect(safeNext('/case/nexus?x=1')).toBe('/case/nexus?x=1')
    expect(safeNext('/settings/data')).toBe('/settings/data')
  })

  test('refuses anything that could leave the origin', () => {
    // `//evil.com` is a protocol-relative URL; `/\evil.com` is treated as one
    // by browsers that normalise backslashes.
    for (const bad of [
      '//evil.com',
      'https://evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      'case',
      '',
      undefined,
      null,
      42,
      ['/case'],
    ]) {
      expect(safeNext(bad)).toBe('/case')
    }
  })
})
