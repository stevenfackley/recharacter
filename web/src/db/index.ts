import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { requireEnv } from '@/lib/env'

export type Db = PostgresJsDatabase<typeof schema>

const g = globalThis as unknown as { __recharacterSql?: postgres.Sql; __recharacterDb?: Db }

/**
 * Lazy singleton. `prepare: false` is mandatory on the Supavisor transaction
 * pooler (:6543) qavren-db fronts at runtime; `max` stays small because the
 * pooler multiplexes for us. Survives Next dev HMR via globalThis.
 */
export function getDb(): Db {
  if (g.__recharacterDb) return g.__recharacterDb
  const sql = postgres(requireEnv('DATABASE_URL'), {
    prepare: false,
    max: process.env.NODE_ENV === 'production' ? 10 : 4,
    connect_timeout: 15,
  })
  g.__recharacterSql = sql
  g.__recharacterDb = drizzle(sql, { schema })
  return g.__recharacterDb
}

export async function closeDb(): Promise<void> {
  await g.__recharacterSql?.end({ timeout: 5 })
  g.__recharacterSql = undefined
  g.__recharacterDb = undefined
}
