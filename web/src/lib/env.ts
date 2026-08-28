import { z } from 'zod'

/**
 * Every environment variable the web tier reads, validated once per process.
 *
 * Deliberately lazy (nothing runs at import): `next build` evaluates route
 * modules without a live environment, and unit tests set variables per case.
 * Values are optional here; call sites that cannot work without one use
 * `requireEnv` so the failure names the variable instead of surfacing as an
 * opaque TypeError deep inside a client library.
 */

const positiveInt = (fallback: number) =>
  z.preprocess((v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : undefined
  }, z.number().int().positive().default(fallback))

const base64Kek = z
  .string()
  .refine(
    (s) => Buffer.from(s, 'base64').length === 32,
    'AI_KEY_ENCRYPTION_SECRET must be 32 bytes, base64',
  )

const schema = z.object({
  // qavren-db: transaction pooler (:6543) at runtime, session (:5432) for migrations.
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_MIGRATE: z.string().min(1).optional(),
  // qavren-auth (Keycloak). The realm's own hostname is the issuer host.
  QAVREN_AUTH_URL: z.string().url().default('https://auth.recharacter.us'),
  QAVREN_REALM: z.string().min(1).default('recharacter'),
  QAVREN_ADMIN_CLIENT_ID: z.string().min(1).default('recharacter-admin-svc'),
  QAVREN_ADMIN_CLIENT_SECRET: z.string().min(1).optional(),
  KEYCLOAK_ADMIN_BASE_URL: z.string().url().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Object storage: Cloudflare R2 in prod, MinIO via S3_ENDPOINT locally/CI.
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.string().url().optional(),
  // AI gateway.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AI_KEY_ENCRYPTION_SECRET: base64Kek.optional(),
  AI_RATE_LIMIT_PER_MINUTE: positiveInt(10),
  AI_MANAGED_DAILY_TOKEN_CAP: positiveInt(2_000_000),
  AI_GLOBAL_DAILY_TOKEN_CAP: positiveInt(20_000_000),
  // Sibling services / billing.
  ROUTING_API_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_PRICE_ID: z.string().min(1).optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

/** Parsed once per process; empty strings count as unset. */
export function getEnv(): Env {
  if (cached) return cached
  const raw: Record<string, string | undefined> = {}
  for (const key of Object.keys(schema.shape)) {
    const v = process.env[key]
    raw[key] = v === '' ? undefined : v
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${issues}`)
  }
  cached = parsed.data
  return cached
}

/** Like `getEnv()[key]`, but throws a message naming the variable when unset. */
export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = getEnv()[key]
  if (v === undefined || v === null) throw new Error(`Missing required environment variable ${key}`)
  return v as NonNullable<Env[K]>
}

/** Tests mutate process.env between cases; drop the memo so they see it. */
export function resetEnvForTests(): void {
  cached = undefined
}
