import { defineConfig } from 'drizzle-kit'

/**
 * `drizzle-kit generate` ONLY. Never run `drizzle-kit migrate` or
 * `drizzle-kit push` against qavren-db: both open with
 * `CREATE SCHEMA IF NOT EXISTS`, which Postgres refuses with 42501 for a role
 * that lacks CREATE on the database — which the app role does, even though it
 * owns the `recharacter` schema. Migrations are applied by `npm run db:migrate`
 * (scripts/migrate.ts), which is what CI and the deploy job call.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['recharacter'],
  migrations: { schema: 'recharacter', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL ?? '' },
})
