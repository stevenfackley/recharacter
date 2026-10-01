import { expect, test } from 'vitest'
import { isSessionCookieName, stripSessionRefresh } from '@/lib/session-cookies'

function responseWith(...setCookies: string[]) {
  const res = new Response('ok')
  for (const line of setCookies) res.headers.append('set-cookie', line)
  return res
}

test('a refreshed session cookie is removed from the response', () => {
  const res = stripSessionRefresh(
    responseWith('authjs.session-token=refreshed; Path=/; HttpOnly; SameSite=lax'),
  )

  expect(res.headers.getSetCookie()).toEqual([])
})

test('chunked and __Secure- session cookies are removed too', () => {
  const res = stripSessionRefresh(
    responseWith(
      'authjs.session-token.0=a; Path=/; HttpOnly',
      'authjs.session-token.1=b; Path=/; HttpOnly',
      '__Secure-authjs.session-token=c; Path=/; Secure; HttpOnly',
      '__Secure-authjs.session-token.0=d; Path=/; Secure; HttpOnly',
      '__Secure-authjs.session-token.12=e; Path=/; Secure; HttpOnly',
    ),
  )

  expect(res.headers.getSetCookie()).toEqual([])
})

test('empty-value deletions survive: they can never resurrect a session', () => {
  // Auth.js clears a cookie it cannot decrypt (secret rotation) with exactly
  // this shape, and sign-out relies on its own deletions reaching the browser.
  const deletions = [
    'authjs.session-token=; Path=/; Max-Age=0; HttpOnly',
    '__Secure-authjs.session-token.1=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
  ]

  const res = stripSessionRefresh(responseWith(...deletions))

  expect(res.headers.getSetCookie()).toEqual(deletions)
})

test('only the refresh is stripped from a mixed response, order of the rest preserved', () => {
  const res = stripSessionRefresh(
    responseWith(
      'authjs.callback-url=%2Fcase; Path=/; HttpOnly',
      'authjs.session-token=refreshed; Path=/; HttpOnly',
      'authjs.session-token.1=; Path=/; Max-Age=0',
      'theme=dark; Path=/',
      '__Secure-authjs.session-token=refreshed; Path=/; Secure',
    ),
  )

  expect(res.headers.getSetCookie()).toEqual([
    'authjs.callback-url=%2Fcase; Path=/; HttpOnly',
    'authjs.session-token.1=; Path=/; Max-Age=0',
    'theme=dark; Path=/',
  ])
})

test('lookalike cookie names are not session cookies', () => {
  const lookalikes = [
    'authjs.session-token-extra=x; Path=/',
    'my-authjs.session-token=x; Path=/',
    'authjs.session-token.abc=x; Path=/',
    'authjs.csrf-token=x; Path=/',
  ]

  const res = stripSessionRefresh(responseWith(...lookalikes))

  expect(res.headers.getSetCookie()).toEqual(lookalikes)
})

test('a response without a session cookie is returned untouched', () => {
  const input = responseWith('theme=dark; Path=/')

  const res = stripSessionRefresh(input)

  expect(res).toBe(input)
  expect(res.headers.getSetCookie()).toEqual(['theme=dark; Path=/'])
})

test('the response body, status and other headers are preserved', async () => {
  const input = new Response('payload', { status: 401, headers: { 'x-keep': '1' } })
  input.headers.append('set-cookie', 'authjs.session-token=refreshed; Path=/')

  const res = stripSessionRefresh(input)

  expect(res.status).toBe(401)
  expect(res.headers.get('x-keep')).toBe('1')
  await expect(res.text()).resolves.toBe('payload')
})

test('anything that is not a Response passes through unchanged', () => {
  // Auth.js's wrapper may hand back undefined when the handler returns nothing.
  expect(stripSessionRefresh(undefined)).toBeUndefined()
  expect(stripSessionRefresh(null)).toBeNull()
  const notAResponse = { headers: { getSetCookie: () => ['authjs.session-token=x'] } }
  expect(stripSessionRefresh(notAResponse)).toBe(notAResponse)
})

test.each([
  ['authjs.session-token', true],
  ['__Secure-authjs.session-token', true],
  ['authjs.session-token.0', true],
  ['__Secure-authjs.session-token.3', true],
  ['authjs.csrf-token', false],
  ['__Secure-authjs.callback-url', false],
  ['authjs.session-token-extra', false],
  ['theme', false],
])('isSessionCookieName(%s) is %s', (name, expected) => {
  expect(isSessionCookieName(name)).toBe(expected)
})
