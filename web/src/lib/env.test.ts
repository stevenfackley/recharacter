import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getEnv, requireEnv, resetEnvForTests } from '@/lib/env'

const TOUCHED = [
  'QAVREN_AUTH_URL',
  'AI_RATE_LIMIT_PER_MINUTE',
  'QAVREN_ADMIN_CLIENT_SECRET',
  'AI_KEY_ENCRYPTION_SECRET',
  'DATABASE_URL',
] as const
const saved: Partial<Record<(typeof TOUCHED)[number], string | undefined>> = {}

describe('env', () => {
  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k]
    resetEnvForTests()
  })
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetEnvForTests()
  })

  it('applies platform defaults', () => {
    delete process.env.QAVREN_AUTH_URL
    const env = getEnv()
    expect(env.QAVREN_AUTH_URL).toBe('https://auth.recharacter.us')
    expect(env.QAVREN_REALM).toBe('recharacter')
    expect(env.QAVREN_ADMIN_CLIENT_ID).toBe('recharacter-admin-svc')
    expect(env.AI_GLOBAL_DAILY_TOKEN_CAP).toBe(20_000_000)
  })

  it('falls back on garbage numeric overrides', () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = 'lots'
    expect(getEnv().AI_RATE_LIMIT_PER_MINUTE).toBe(10)
  })

  it('honours a valid numeric override', () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = '3'
    expect(getEnv().AI_RATE_LIMIT_PER_MINUTE).toBe(3)
  })

  it('treats an empty string as unset', () => {
    process.env.DATABASE_URL = ''
    expect(getEnv().DATABASE_URL).toBeUndefined()
  })

  it('requireEnv names the missing variable', () => {
    delete process.env.QAVREN_ADMIN_CLIENT_SECRET
    expect(() => requireEnv('QAVREN_ADMIN_CLIENT_SECRET')).toThrow(/QAVREN_ADMIN_CLIENT_SECRET/)
  })

  it('rejects a KEK that is not 32 bytes of base64', () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'short'
    expect(() => getEnv()).toThrow(/AI_KEY_ENCRYPTION_SECRET/)
  })

  it('accepts a 32-byte base64 KEK', () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString('base64')
    expect(getEnv().AI_KEY_ENCRYPTION_SECRET).toBeDefined()
  })
})
