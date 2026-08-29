import { afterEach, describe, expect, test, vi } from 'vitest'

/**
 * Two things about `@/auth`: the surface every route and action imports from
 * it, and the IMPORT-GRAPH INVARIANT written at the top of auth.ts — proxy.ts
 * pulls `auth` in on every request, so this module must never transitively
 * load the DB client. The invariant is proven with tripwire mocks: a factory
 * that throws the moment anything in the graph imports the forbidden module.
 */

const TRIPWIRES = ['postgres', '@/db', '@/lib/env'] as const

afterEach(() => {
  for (const id of TRIPWIRES) vi.doUnmock(id)
  vi.resetModules()
})

describe('@/auth', () => {
  test('exports the Auth.js surface: GET+POST handlers, auth, signIn, signOut', async () => {
    const mod = await import('@/auth')

    expect(typeof mod.handlers.GET).toBe('function')
    expect(typeof mod.handlers.POST).toBe('function')
    expect(typeof mod.auth).toBe('function')
    expect(typeof mod.signIn).toBe('function')
    expect(typeof mod.signOut).toBe('function')
  })

  test('re-exports the very config it was built from', async () => {
    const mod = await import('@/auth')
    const { authConfig } = await import('@/auth.config')

    expect(mod.authConfig).toBe(authConfig)
  })

  test('IMPORT-GRAPH INVARIANT: loading @/auth never loads postgres, @/db, or the env module', async () => {
    vi.resetModules()
    for (const id of TRIPWIRES) {
      vi.doMock(id, () => {
        throw new Error(`${id} must not be imported by @/auth`)
      })
    }

    const mod = await import('@/auth')

    expect(typeof mod.auth).toBe('function')
    expect(typeof mod.handlers.GET).toBe('function')
  })

  test('the tripwire is live: a module that DOES import postgres fails to load under it', async () => {
    // Guards the invariant test against vacuity — if a throwing factory were
    // silently ignored, the test above would pass for the wrong reason.
    vi.resetModules()
    vi.doMock('postgres', () => {
      throw new Error('postgres tripwire')
    })

    // Vitest wraps a throwing factory in its own "error when mocking a module"
    // error (the original rides along as `cause`); either text proves the trip.
    const failure = await import('@/db').then(
      () => null,
      (e: unknown) => e as Error & { cause?: unknown },
    )

    expect(failure).toBeInstanceOf(Error)
    const text = [
      failure!.message,
      failure!.cause instanceof Error ? failure!.cause.message : String(failure!.cause ?? ''),
    ].join(' ')
    expect(text).toMatch(/postgres tripwire|error when mocking a module/)
  })
})
