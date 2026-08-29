import { randomBytes } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'

/**
 * The one journey nothing else can prove: register on the real realm, hold a
 * real session, export, then delete — and confirm the Keycloak user is gone,
 * not merely signed out. Everything it touches is real, so it is gated twice.
 *
 *  1. `E2E_ALLOW_REGISTRATION` must be set. Running this creates an account on
 *     the live `recharacter` realm; nothing should do that by accident.
 *  2. The target origin must be a registered redirect URI on the
 *     `recharacter-web` client (`https://recharacter.us/*` and
 *     `http://localhost:3000/*`). The local harness serves :3123, which is not
 *     one — locally this spec can only be type-checked and seen to skip.
 *
 * It runs for real in .github/workflows/deploy.yml against https://recharacter.us.
 */
test.skip(
  !process.env.E2E_ALLOW_REGISTRATION,
  'set E2E_ALLOW_REGISTRATION=1 to register a throwaway account on the live realm',
)

// A registration, an OIDC round trip, an export and a deletion, each over the
// public internet.
test.setTimeout(180_000)

/** Every key `collectExport` promises. A dropped one is a silent data loss. */
const EXPORT_KEYS = [
  'exportedAt',
  'ownerId',
  'case',
  'serviceFacts',
  'caseContext',
  'evidenceItems',
  'nexusAnswers',
  'drafts',
  'aiUsage',
  'entitlements',
  'pendingCheckouts',
  'aiCredentials',
  'uploadedDocuments',
] as const

const CONFIRM_LABEL = 'I understand this permanently deletes my account and everything in it'
const KEYCLOAK = /^https:\/\/auth\.recharacter\.us\//

type Account = { username: string; email: string; password: string }

function newAccount(): Account {
  const d = new Date()
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
  // Recognisable as ours and as disposable, in a realm a human also uses.
  const username = `e2e-${day}-${randomBytes(3).toString('hex')}`
  return {
    username,
    // example.com is reserved by RFC 2606 — no real inbox is ever addressed.
    email: `${username}@example.com`,
    // 28 chars with all four classes, so no realm password policy rejects it.
    // It is never printed, asserted on, or written to a report.
    password: `Aa1!${randomBytes(18).toString('base64url')}`,
  }
}

/**
 * Every occurrence of the named keys, anywhere in the structure. The ID token is
 * kept on the JWT cookie for RP-initiated logout and must never reach the
 * session object, which Auth.js serves verbatim at GET /api/auth/session.
 */
function findKeys(value: unknown, needles: readonly string[], path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findKeys(v, needles, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(needles.includes(k.toLowerCase()) ? [`${path}.${k}`] : []),
      ...findKeys(v, needles, `${path}.${k}`),
    ])
  }
  return []
}

/** Same-origin fetch from the signed-in page, so the session cookie applies. */
async function fetchAsUser(page: Page, path: string) {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { headers: { accept: 'application/json' } })
    const text = await res.text()
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      text,
    }
  }, path)
}

async function deleteAccountFromSettings(page: Page) {
  await page.goto('/settings/data')
  await page.getByRole('checkbox', { name: CONFIRM_LABEL }).check()
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await page.waitForURL(/\/login\?deleted=1$/)
}

let account: Account
let registered = false
let deleted = false

test.beforeEach(() => {
  account = newAccount()
  registered = false
  deleted = false
})

// A run that registers and then fails before deletion would leave a live user on
// the realm. One more attempt, best effort — if it also fails, the failure the
// test already reported is the thing to go and read.
test.afterEach(async ({ page }) => {
  if (!registered || deleted) return
  try {
    await deleteAccountFromSettings(page)
  } catch {
    console.warn(`e2e cleanup failed — realm user "${account.username}" may still exist`)
  }
})

test('register, hold a session, export, delete — and the realm user is gone', async ({
  page,
  baseURL,
}) => {
  const base = (baseURL ?? '').replace(/\/+$/, '')

  await test.step('register on the realm and land signed in', async () => {
    await page.goto('/signup')
    await page.getByRole('button', { name: 'Create your account' }).click()
    await page.waitForURL(KEYCLOAK)

    await page.getByLabel('Username', { exact: true }).fill(account.username)
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    await page.getByLabel('Confirm password', { exact: true }).fill(account.password)
    await page.getByLabel('Email', { exact: true }).fill(account.email)
    await page.getByLabel('First name', { exact: true }).fill('E2E')
    await page.getByLabel('Last name', { exact: true }).fill('Test')
    await page.getByRole('button', { name: 'Register' }).click()

    // safeNext's default destination for a signup with no ?next=.
    await page.waitForURL(`${base}/case`)
    registered = true
    await expect(page).toHaveTitle(/Your case/)
  })

  await test.step('the session identifies the user and carries no ID token', async () => {
    const res = await fetchAsUser(page, '/api/auth/session')
    expect(res.status).toBe(200)
    const session = JSON.parse(res.text) as { user?: { id?: string; email?: string } }
    // `user.id` is the Keycloak `sub`; it becomes owner_id on every row.
    expect(session.user?.id).toBeTruthy()
    expect(session.user?.email).toBe(account.email)
    expect(findKeys(session, ['idtoken', 'id_token'])).toEqual([])
  })

  await test.step('the export is complete and uncacheable', async () => {
    const res = await fetchAsUser(page, '/api/account/export')
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('application/json')
    // The body is the veteran's whole record; it must not sit in a shared cache.
    expect(res.cacheControl).toContain('no-store')
    const body = JSON.parse(res.text) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([...EXPORT_KEYS].sort())
  })

  await test.step('deletion empties the account and says so', async () => {
    await deleteAccountFromSettings(page)
    deleted = true
    await expect(page.getByRole('status')).toContainText(
      'Your account and everything in it were deleted',
    )

    const res = await fetchAsUser(page, '/api/auth/session')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toBeNull()
  })

  await test.step('the realm user itself is gone, not just signed out', async () => {
    // The app-side redirect proves nothing about Keycloak. Only the realm
    // refusing the credentials proves the admin-svc deletion path actually ran.
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(KEYCLOAK)
    await page.getByLabel('Username or email', { exact: true }).fill(account.username)
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await expect(page.getByText('Invalid username or password.')).toBeVisible()
  })
})
