// @vitest-environment node
//
// scripts/migrate.ts end to end, the way CI runs it: a child process per run,
// against throwaway databases created on the dev server and dropped at the end.
// The script is a replacement for drizzle's stock migrate() with three promises
// of its own — one transaction under an advisory lock, tolerance of a
// pre-created schema, and never printing the DSN — and each is exercised here.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from './helpers'
import { closeDb } from '@/db'

const execFileAsync = promisify(execFile)

const WEB = path.resolve(__dirname, '..')
// The tsx CLI through the node binary that runs this test: no `npx` shim, no
// shell, so the same invocation works on Windows and in CI.
const TSX = path.join(WEB, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SCRIPT = path.join('scripts', 'migrate.ts')

const APP_TABLES = [
  'ai_attempts', 'ai_credentials', 'ai_usage', 'case_context', 'cases', 'drafts',
  'entitlements', 'evidence_items', 'nexus_answers', 'pending_checkouts', 'service_facts',
]

type Run = { code: number | string; stdout: string; stderr: string }

/**
 * One migrator run. The child never inherits this process's own database URL:
 * every case names the database it targets, or deliberately names none.
 */
async function runMigrator(env: Record<string, string>): Promise<Run> {
  // NodeJS.ProcessEnv, not Record<string, string>: execFile's options type
  // requires it, and this project's env typing makes NODE_ENV mandatory on it.
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.DATABASE_URL
  delete childEnv.DATABASE_URL_MIGRATE
  Object.assign(childEnv, env)
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, SCRIPT], {
      cwd: WEB, env: childEnv, windowsHide: true,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string }
    return { code: e.code ?? 'unknown', stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const created: string[] = []

/** A brand-new, empty database on the dev server, dropped in afterAll. */
async function freshDatabase(): Promise<{ name: string; url: string }> {
  const name = `recharacter_migtest_${randomBytes(4).toString('hex')}`
  await db().execute(sql.raw(`CREATE DATABASE "${name}"`))
  created.push(name)
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${name}`
  return { name, url: url.toString() }
}

/** What the migrator left behind, read over a one-off connection to that database. */
async function inspect(url: string): Promise<{ ledgerRows: number; tables: string[] }> {
  const client = postgres(url, { max: 1, prepare: false })
  try {
    const [{ n }] = await client<{ n: number }[]>`
      select count(*)::int as n from recharacter.__drizzle_migrations`
    const tables = (await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'recharacter' and table_type = 'BASE TABLE' order by table_name`
    ).map((r) => r.table_name)
    return { ledgerRows: n, tables }
  } finally {
    await client.end()
  }
}

async function runSql(url: string, statement: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false })
  try {
    await client.unsafe(statement)
  } finally {
    await client.end()
  }
}

describe.skipIf(!process.env.DATABASE_URL)('scripts/migrate.ts', { timeout: 120_000 }, () => {
  afterAll(async () => {
    for (const name of created) {
      await db().execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
    }
    await closeDb()
  })

  describe('against one fresh database', () => {
    let url: string
    beforeAll(async () => { ({ url } = await freshDatabase()) })

    it('applies the migration once: one ledger row and every app table', async () => {
      const run = await runMigrator({ DATABASE_URL_MIGRATE: url })
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('migrations applied')
      expect(run.stdout).not.toContain('already up to date')
      const { ledgerRows, tables } = await inspect(url)
      expect(ledgerRows).toBe(1)
      expect(tables).toEqual([...APP_TABLES, '__drizzle_migrations'].sort())
    })

    it('is idempotent: a second run says so, exits 0, and adds no ledger row', async () => {
      const run = await runMigrator({ DATABASE_URL_MIGRATE: url })
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('already up to date')
      expect((await inspect(url)).ledgerRows).toBe(1)
    })
  })

  it('serialises concurrent runs under the advisory lock: both exit 0, the migration applies once', async () => {
    const { url } = await freshDatabase()
    const [a, b] = await Promise.all([
      runMigrator({ DATABASE_URL_MIGRATE: url }),
      runMigrator({ DATABASE_URL_MIGRATE: url }),
    ])
    expect([a.code, b.code]).toEqual([0, 0])
    expect(a.stderr + b.stderr).toBe('')
    // Exactly one of them did the work; the other queued behind the lock, then
    // read the ledger the first one committed.
    const upToDate = [a, b].filter((r) => r.stdout.includes('already up to date'))
    expect(upToDate).toHaveLength(1)
    const { ledgerRows, tables } = await inspect(url)
    expect(ledgerRows).toBe(1)
    expect(tables).toContain('cases')
  })

  it('exits 1 naming both variables when neither database URL is set', async () => {
    const run = await runMigrator({})
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('DATABASE_URL_MIGRATE')
    expect(run.stderr).toContain('DATABASE_URL')
  })

  it('never prints the DSN: an unreachable server fails with code and message only', async () => {
    const run = await runMigrator({ DATABASE_URL_MIGRATE: 'postgres://u:SECRETPW123@127.0.0.1:1/x' })
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/code:/)
    expect(run.stderr).toContain('ECONNREFUSED')
    expect(run.stdout).not.toContain('SECRETPW123')
    expect(run.stderr).not.toContain('SECRETPW123')
  })

  it('tolerates a pre-created schema (qavren-db): no CREATE SCHEMA, tables still land', async () => {
    // On qavren-db the schema is provisioned ahead of time and the role has no
    // CREATE on the database, so the migrator must never issue CREATE SCHEMA
    // when the namespace exists — including inside the migration's own DO block.
    const { url } = await freshDatabase()
    await runSql(url, 'CREATE SCHEMA "recharacter"')
    const run = await runMigrator({ DATABASE_URL_MIGRATE: url })
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('migrations applied')
    const { ledgerRows, tables } = await inspect(url)
    expect(ledgerRows).toBe(1)
    for (const table of APP_TABLES) expect(tables).toContain(table)
  })
})
