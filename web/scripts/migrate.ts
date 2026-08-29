import path from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

// Session-mode URL (:5432 on qavren-db). The Supavisor transaction pooler cannot
// hold the session-scoped advisory lock or the long transaction this needs.
//
// Prod URLs (DATABASE_URL, DATABASE_URL_MIGRATE) MUST carry `?sslmode=require`:
// postgres-js reads sslmode out of the URL, and without it the connection to
// qavren-db is made in the clear.
const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL_MIGRATE (session URL) or DATABASE_URL')
  process.exit(1)
}

const SCHEMA = 'recharacter'
const TABLE = '__drizzle_migrations'
// Arbitrary but fixed: every migrator run contends on this one key.
const LOCK_KEY = 4919283

/**
 * Drizzle's stock `migrate()` is unusable against qavren-db: it opens with an
 * unconditional `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>`, and Postgres
 * checks CREATE on the *database* before it honours IF NOT EXISTS — so that
 * statement raises 42501 for the app role even though the schema already exists
 * and the role owns it. Drizzle exposes no way to skip it, so we drive the same
 * loop ourselves.
 *
 * The whole run is ONE transaction that takes `pg_advisory_xact_lock` before it
 * reads anything. Without the lock two concurrent runs (two CI deploys, or a
 * deploy racing a manual run) both read an empty ledger and both apply every
 * pending migration: duplicate ledger rows, and the migration body executed
 * twice. The lock has to cover the read of `last`, not just the writes, which is
 * why the bookkeeping table, the read and the apply loop all live inside it.
 * Postgres releases it at COMMIT or ROLLBACK, including on crash.
 *
 * Everything else matches upstream: drizzle's own `readMigrationFiles` supplies
 * the ordering and the sha256 hashes, and the ledger keeps drizzle's column
 * shape, so a stock `migrate()` would interoperate with this ledger.
 */
async function main() {
  // Resolved against this file, not cwd, so the migrator works when invoked from
  // the repo root (CI deploy) as well as from web/.
  const migrations = readMigrationFiles({
    migrationsFolder: path.resolve(__dirname, '../drizzle'),
    migrationsSchema: SCHEMA,
    migrationsTable: TABLE,
  })

  // onnotice is silenced: CREATE TABLE IF NOT EXISTS emits a 42P07 NOTICE on
  // every re-run, which reads like a failure in CI output.
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} })
  let applied = 0
  try {
    await sql.begin(async (tx) => {
      // FIRST statement: serialize the run. Deliberately taken before
      // lock_timeout is set — a concurrent migrator should queue for its turn,
      // not fail.
      await tx.unsafe(`select pg_advisory_xact_lock(${LOCK_KEY})`)
      // Applies from here on: a DDL lock we cannot get in 5s means something
      // else holds the table, and blocking a deploy forever is worse than failing.
      await tx.unsafe(`SET LOCAL lock_timeout = '5s'`)
      await tx.unsafe(`SET LOCAL statement_timeout = '5min'`)

      // Create the schema only when genuinely absent (a fresh local Postgres). On
      // qavren-db it is pre-created and owned by the role, so we never issue the
      // statement and never trip the database-level CREATE check.
      const [existing] = await tx`select 1 from pg_namespace where nspname = ${SCHEMA}`
      if (!existing) await tx.unsafe(`CREATE SCHEMA "${SCHEMA}"`)

      // The bookkeeping table lives INSIDE the app schema: the qavren-db role
      // cannot create the default `drizzle` schema.
      await tx.unsafe(
        `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${TABLE}" (` +
          `id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      )

      const [last] = await tx.unsafe(
        `select created_at from "${SCHEMA}"."${TABLE}" order by created_at desc limit 1`,
      )

      for (const migration of migrations) {
        if (last && Number(last.created_at) >= migration.folderMillis) continue
        // Statements are split on `--> statement-breakpoint`, not on `;`, so a
        // plpgsql body containing semicolons survives intact.
        for (const stmt of migration.sql) await tx.unsafe(stmt)
        await tx.unsafe(
          `insert into "${SCHEMA}"."${TABLE}" ("hash", "created_at") values($1, $2)`,
          [migration.hash, migration.folderMillis],
        )
        applied += 1
      }
    })

    console.log(applied === 0 ? 'migrations applied (already up to date)' : 'migrations applied')
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  // Code and message ONLY. A postgres-js connection error carries the full DSN
  // (password included) on `err.input`, so logging the whole object leaks the
  // database password into CI output.
  console.error({ code: err?.code, message: err?.message })
  process.exit(1)
})
