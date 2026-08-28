import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

// Session-mode URL (:5432 on qavren-db). The transaction pooler cannot hold the
// advisory lock / transaction the migrator needs.
const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL_MIGRATE (session URL) or DATABASE_URL')
  process.exit(1)
}

const SCHEMA = 'recharacter'
const TABLE = '__drizzle_migrations'

/**
 * Drizzle's stock `migrate()` is unusable against qavren-db: it opens with an
 * unconditional `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>`, and Postgres
 * checks CREATE on the *database* before it honours IF NOT EXISTS — so that
 * statement raises 42501 for the app role even though the schema already exists
 * and the role owns it. Drizzle exposes no way to skip it, so we drive the same
 * loop ourselves.
 *
 * Everything else matches upstream: drizzle's own `readMigrationFiles` supplies
 * the ordering and the sha256 hashes, and the ledger keeps drizzle's column
 * shape, so a stock `migrate()` would interoperate with this ledger.
 */
async function main() {
  const sql = postgres(url!, { max: 1, prepare: false })
  try {
    // Create the schema only when genuinely absent (a fresh local Postgres). On
    // qavren-db it is pre-created and owned by the role, so we never issue the
    // statement and never trip the database-level CREATE check.
    const [existing] = await sql`select 1 from pg_namespace where nspname = ${SCHEMA}`
    if (!existing) await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)

    // The bookkeeping table lives INSIDE the app schema: the qavren-db role cannot
    // create the default `drizzle` schema.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${TABLE}" (` +
        `id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    )

    const migrations = readMigrationFiles({
      migrationsFolder: './drizzle',
      migrationsSchema: SCHEMA,
      migrationsTable: TABLE,
    })

    const [last] = await sql.unsafe(
      `select created_at from "${SCHEMA}"."${TABLE}" order by created_at desc limit 1`,
    )

    let applied = 0
    await sql.begin(async (tx) => {
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
  console.error(err)
  process.exit(1)
})
