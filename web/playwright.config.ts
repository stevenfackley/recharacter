import { defineConfig, devices } from '@playwright/test'

/**
 * E2E harness. Two targets:
 *
 *  - `E2E_BASE_URL` unset (local dev, CI): Playwright starts the production
 *    build itself — `next start` on :3123, with AUTH_URL/APP_BASE_URL pointed
 *    at that port so OAuth redirect URIs and the sign-out Origin check are
 *    self-consistent. Build first: `npm run build`.
 *  - `E2E_BASE_URL` set (e.g. https://recharacter.us): the deployed target is
 *    used as-is; nothing is started or reused locally.
 *
 * e2e/public.spec.ts needs no credentials and is safe against any target.
 * e2e/account-lifecycle.spec.ts additionally requires E2E_ALLOW_REGISTRATION=1
 * and a target whose origin is a registered redirect URI on the
 * `recharacter-web` Keycloak client — localhost:3123 is not, so locally it can
 * only be dry-run as skipped (see docs/development.md § End-to-end).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3123'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx next start -p 3123',
        // Auth- and DB-free liveness probe; a broken AUTH_SECRET must surface
        // as a failing test, not as "the server never came up".
        url: 'http://localhost:3123/api/health',
        reuseExistingServer: true,
        timeout: 60_000,
        env: {
          AUTH_URL: 'http://localhost:3123',
          APP_BASE_URL: 'http://localhost:3123',
        },
      },
})
