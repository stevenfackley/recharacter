import { test, expect } from '@playwright/test'

/**
 * Anonymous end-to-end checks. Nothing here signs in, writes, or needs a
 * credential, so it is safe to point at any target — including production
 * straight after a deploy (.github/workflows/deploy.yml).
 *
 * The sign-in/sign-up cases deliberately stop AT the Keycloak page: they assert
 * the authorization request we hand off, never anything behind it.
 */

/** The config always sets one; the fixture is typed optional. */
function requireBase(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured — see playwright.config.ts')
  return baseURL.replace(/\/+$/, '')
}

test.describe('public pages', () => {
  for (const path of ['/', '/login', '/signup', '/terms', '/privacy']) {
    test(`GET ${path} is 200`, async ({ request }) => {
      const res = await request.get(path)
      expect(res.status(), `${path} should render for an anonymous visitor`).toBe(200)
    })
  }

  test('/login names the sign-in service the address bar will show', async ({ page }) => {
    // The point of the copy: a veteran who lands on auth.recharacter.us mid-flow
    // has to have been told that hostname *before* it appears.
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('main')).toContainText('auth.recharacter.us')
  })
})

test.describe('security headers', () => {
  test('/login carries the baseline headers from next.config.ts', async ({ request }) => {
    const res = await request.get('/login')
    expect(res.status()).toBe(200)
    const h = res.headers()

    // same-origin, NOT no-referrer: a fully suppressed referrer makes a no-JS
    // form POST arrive with `Origin: null`, which Next's server-action CSRF
    // check rejects — every <form action={serverAction}> would 500 before
    // hydration. See the comment in next.config.ts.
    expect(h['referrer-policy']).toBe('same-origin')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()')
    // Substring, not equality: an edge (Cloudflare) may append directives of its
    // own to HSTS. The two that are ours are the two asserted.
    expect(h['strict-transport-security']).toContain('max-age=31536000')
    expect(h['strict-transport-security']).toContain('includeSubDomains')
  })
})

test.describe('unauthenticated API surface', () => {
  test('/api/health answers directly, with no redirect', async ({ request }) => {
    // The proxy matcher excludes it on purpose: container liveness must not
    // depend on the auth provider being reachable.
    const res = await request.get('/api/health', { maxRedirects: 0 })
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('/api/auth/session is null for an anonymous caller', async ({ request }) => {
    const res = await request.get('/api/auth/session')
    expect(res.status()).toBe(200)
    // Auth.js serves this object verbatim, so `null` is also the assertion that
    // nothing leaks to a caller holding no cookie.
    expect(await res.json()).toBeNull()
  })

  test('/api/auth/providers offers exactly one provider, keycloak', async ({
    request,
    baseURL,
  }) => {
    const base = requireBase(baseURL)
    const res = await request.get('/api/auth/providers')
    expect(res.status()).toBe(200)
    const providers = (await res.json()) as Record<
      string,
      { id: string; type: string; callbackUrl: string }
    >
    expect(Object.keys(providers)).toEqual(['keycloak'])
    expect(providers.keycloak.id).toBe('keycloak')
    expect(providers.keycloak.type).toBe('oidc')
    // Must match a URI registered on the realm client, or the handoff below
    // comes back "Invalid parameter: redirect_uri".
    expect(providers.keycloak.callbackUrl).toBe(`${base}/api/auth/callback/keycloak`)
  })

  test('/api/account/export refuses an anonymous caller', async ({ request }) => {
    const res = await request.get('/api/account/export', { maxRedirects: 0 })
    expect(res.status()).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })
})

test.describe('proxy: what is guarded and what is not', () => {
  // Every path here is also enforced inside its own page/handler; the proxy is a
  // redirect convenience. What these cases pin is the *matcher*, the part with
  // no second line of defence — a path it silently skips is a path whose 401
  // depends entirely on a handler remembering to check.
  for (const path of ['/case', '/case/intake', '/settings/data', '/settings/ai', '/case?x=1']) {
    test(`page ${path} redirects to /login carrying next=`, async ({ request, baseURL }) => {
      const base = requireBase(baseURL)
      const res = await request.get(path, { maxRedirects: 0 })
      expect(res.status()).toBe(307)
      // Next normalises a same-origin proxy redirect to an origin-relative
      // Location, so this assertion is identical on localhost and on prod.
      const expected = new URL('/login', base)
      expected.searchParams.set('next', path)
      expect(res.headers()['location']).toBe(`${expected.pathname}${expected.search}`)
    })
  }

  for (const path of ['/api/ai/extract', '/api/packet', '/api/account/export']) {
    test(`api ${path} answers 401 JSON, not a redirect`, async ({ request }) => {
      // A 307 to an HTML login page reaches an API caller as an unparseable body.
      const res = await request.get(path, { maxRedirects: 0 })
      expect(res.status()).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthenticated' })
    })
  }

  test('/api/ai/extract.v2 is guarded — a dot in a path is not a static file', async ({
    request,
  }) => {
    // Regression pin: the stock Next matcher excludes anything *containing* a
    // dot, which would silently unguard this route. Ours excludes an anchored
    // list of asset extensions instead.
    const res = await request.get('/api/ai/extract.v2', { maxRedirects: 0 })
    expect(res.status()).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  test('/casework is not swallowed by the /case prefix', async ({ request }) => {
    const res = await request.get('/casework', { maxRedirects: 0 })
    expect(res.status(), '/casework is a 404, not a login redirect').toBe(404)
    expect(res.headers()['location'] ?? '').not.toContain('/login')
  })

  test('/favicon.ico is served, not redirected', async ({ request }) => {
    const res = await request.get('/favicon.ico', { maxRedirects: 0 })
    expect(res.status()).toBe(200)
    expect(res.headers()['location'] ?? '').toBe('')
  })
})

test.describe('sign-in handoff', () => {
  const AUTHORIZE = /^https:\/\/auth\.recharacter\.us\//

  /**
   * Assert the authorization request itself. We never go past the Keycloak page
   * — from a target whose origin is not a registered redirect URI Keycloak
   * renders an error there, and that is fine: the URL is the artefact under test.
   */
  function assertAuthorizeUrl(url: URL, base: string) {
    expect(url.origin).toBe('https://auth.recharacter.us')
    expect(url.pathname).toBe('/realms/recharacter/protocol/openid-connect/auth')
    expect(url.searchParams.get('client_id')).toBe('recharacter-web')
    // Public client, so PKCE is all that stands between an intercepted code and
    // a token. S256, never `plain`.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('redirect_uri')).toBe(`${base}/api/auth/callback/keycloak`)
    expect(url.searchParams.get('scope')?.split(' ')).toContain('openid')
    expect(url.searchParams.get('response_type')).toBe('code')
  }

  test('/login hands off to the realm with a PKCE authorization request', async ({
    page,
    baseURL,
  }) => {
    const base = requireBase(baseURL)
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(AUTHORIZE)
    const url = new URL(page.url())
    assertAuthorizeUrl(url, base)
    expect(url.searchParams.get('prompt')).toBeNull()
  })

  test('/signup hands off the same request plus prompt=create', async ({ page, baseURL }) => {
    const base = requireBase(baseURL)
    await page.goto('/signup')
    await page.getByRole('button', { name: 'Create your account' }).click()
    await page.waitForURL(AUTHORIZE)
    const url = new URL(page.url())
    assertAuthorizeUrl(url, base)
    // There is no separate registration endpoint; Keycloak >= 26.1 opens the
    // register form on this hint alone.
    expect(url.searchParams.get('prompt')).toBe('create')
  })
})

test.describe('sign-out is POST-only and cross-site proof', () => {
  // A cross-site form must not be able to log someone out mid-petition.
  test('no Origin but Sec-Fetch-Site: cross-site is refused', async ({ request }) => {
    const res = await request.post('/auth/signout', {
      headers: { 'sec-fetch-site': 'cross-site' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  test('a foreign Origin is refused', async ({ request }) => {
    const res = await request.post('/auth/signout', {
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })
})
