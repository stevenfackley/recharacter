import { config } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb, type Db } from '@/db'
import { MemoryObjectStore } from '@/lib/storage/object-store'

config({ path: '.env.local' })

export const db = () => getDb()
export const freshOwner = () => randomUUID()
export const memoryStore = () => new MemoryObjectStore()

/** Postgres error code of a thrown drizzle/postgres-js error, else undefined. */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Runs `run` inside a transaction that is allowed to delete from the append-only ledgers. */
export async function allowLedgerDelete<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL recharacter.allow_ledger_delete = 'on'`))
    return run(tx)
  })
}
