import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The Postgres client singleton. What is pinned here is the Supavisor contract
 * (`prepare: false` on the transaction pooler, a small pool), the belt-and-braces
 * TLS in production, and the globalThis memo that survives Next dev HMR. The
 * driver and drizzle are replaced; nothing here opens a socket.
 */

const postgresFactory = vi.fn()
vi.mock('postgres', () => ({
  default: (...args: unknown[]) => postgresFactory(...args),
}))

const drizzleSpy = vi.fn()
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (...args: unknown[]) => drizzleSpy(...args),
}))

type FakeSql = { end: ReturnType<typeof vi.fn> }
const g = globalThis as unknown as { __recharacterSql?: FakeSql; __recharacterDb?: unknown }

const URL = 'postgres://app:secret@db.example:6543/recharacter?sslmode=require'

function clearGlobals() {
  delete g.__recharacterSql
  delete g.__recharacterDb
}

/** Fresh module registry, fresh env memo, a default DATABASE_URL, no leftover singleton. */
async function fresh(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  clearGlobals()
  vi.stubEnv('DATABASE_URL', URL)
  vi.stubEnv('NODE_ENV', 'test')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const { resetEnvForTests } = await import('@/lib/env')
  resetEnvForTests()
  return import('@/db')
}

/** The options object handed to postgres() on the nth construction. */
function optionsOfCall(n = 0) {
  return postgresFactory.mock.calls[n][1] as Record<string, unknown>
}

beforeEach(() => {
  postgresFactory.mockReset().mockImplementation((): FakeSql => ({ end: vi.fn(async () => {}) }))
  drizzleSpy.mockReset().mockImplementation((client: unknown) => ({ client }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  clearGlobals()
  const { resetEnvForTests } = await import('@/lib/env')
  resetEnvForTests()
})

describe('getDb', () => {
  test('memoizes on globalThis.__recharacterDb: two calls, one client, one drizzle', async () => {
    const { getDb } = await fresh()

    const first = getDb()
    const second = getDb()

    expect(second).toBe(first)
    expect(g.__recharacterDb).toBe(first)
    expect(postgresFactory).toHaveBeenCalledTimes(1)
    expect(drizzleSpy).toHaveBeenCalledTimes(1)
  })

  test('drizzle wraps the very client postgres() returned, with the schema attached', async () => {
    const { getDb } = await fresh()
    const db = getDb() as unknown as { client: unknown }

    const sql = postgresFactory.mock.results[0].value
    expect(db.client).toBe(sql)
    expect(g.__recharacterSql).toBe(sql)
    expect(drizzleSpy).toHaveBeenCalledWith(sql, { schema: expect.objectContaining({}) })
    expect((drizzleSpy.mock.calls[0][1] as { schema: unknown }).schema).toBe(await import('@/db/schema'))
  })

  test('DATABASE_URL unset → throws naming it, and no client is created', async () => {
    const { getDb } = await fresh({ DATABASE_URL: undefined })

    expect(() => getDb()).toThrow('Missing required environment variable DATABASE_URL')
    expect(postgresFactory).not.toHaveBeenCalled()
    expect(g.__recharacterDb).toBeUndefined()
    expect(g.__recharacterSql).toBeUndefined()
  })

  test('the connection string is passed through verbatim (sslmode rides in the URL)', async () => {
    const { getDb } = await fresh()
    getDb()

    expect(postgresFactory.mock.calls[0][0]).toBe(URL)
  })

  test('production: TLS is required and the pool is 10', async () => {
    const { getDb } = await fresh({ NODE_ENV: 'production' })
    getDb()

    expect(optionsOfCall()).toEqual(expect.objectContaining({ ssl: 'require', max: 10 }))
  })

  test('non-production: TLS is left to the URL and the pool is 4', async () => {
    const { getDb } = await fresh({ NODE_ENV: 'development' })
    getDb()

    const opts = optionsOfCall()
    expect(opts.ssl).toBeUndefined()
    expect(opts.max).toBe(4)
  })

  test('prepare: false in every environment — mandatory on the Supavisor transaction pooler', async () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
      const { getDb } = await fresh({ NODE_ENV })
      getDb()
      expect(optionsOfCall(), NODE_ENV).toEqual(expect.objectContaining({ prepare: false }))
      postgresFactory.mockClear()
    }
  })

  test('idle connections are handed back to the pooler, and connecting has a deadline', async () => {
    const { getDb } = await fresh()
    getDb()

    expect(optionsOfCall()).toEqual(expect.objectContaining({ idle_timeout: 30, connect_timeout: 15 }))
  })
})

describe('closeDb', () => {
  test('ends the client with a bounded timeout and clears both globals', async () => {
    const { getDb, closeDb } = await fresh()
    getDb()
    const sql = g.__recharacterSql!

    await closeDb()

    expect(sql.end).toHaveBeenCalledTimes(1)
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 })
    expect(g.__recharacterSql).toBeUndefined()
    expect(g.__recharacterDb).toBeUndefined()
  })

  test('a getDb after closeDb constructs a NEW client rather than reviving the ended one', async () => {
    const { getDb, closeDb } = await fresh()
    const first = getDb()
    const firstSql = g.__recharacterSql

    await closeDb()
    const second = getDb()

    expect(second).not.toBe(first)
    expect(g.__recharacterSql).not.toBe(firstSql)
    expect(postgresFactory).toHaveBeenCalledTimes(2)
  })

  test('calling closeDb twice is safe: the second call finds nothing to end', async () => {
    const { getDb, closeDb } = await fresh()
    getDb()
    const sql = g.__recharacterSql!

    await closeDb()
    await expect(closeDb()).resolves.toBeUndefined()

    expect(sql.end).toHaveBeenCalledTimes(1)
  })

  test('closeDb before any getDb is a no-op', async () => {
    const { closeDb } = await fresh()

    await expect(closeDb()).resolves.toBeUndefined()
    expect(postgresFactory).not.toHaveBeenCalled()
  })
})
