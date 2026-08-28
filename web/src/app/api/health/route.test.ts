import { expect, test } from 'vitest'
import { GET } from './route'

test('GET /api/health returns { status: "ok" }', async () => {
  const response = await GET()

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ status: 'ok' })
})
