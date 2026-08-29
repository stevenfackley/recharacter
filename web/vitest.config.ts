import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    globals: true,
    setupFiles: [],
    // `next` ships no "exports" map, so `next/server` only resolves by CJS
    // extension guessing. Vite does that; Node's ESM resolver — which vite-node
    // uses for externalized dependencies — does not, so `next-auth` importing
    // `next/server` dies on load. Run these through Vite's resolver instead.
    server: { deps: { inline: ['next-auth', '@auth/core', '@qavren/auth-next'] } },
    projects: [
      {
        // Component + pure-logic tests under src/ render against jsdom.
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom' },
      },
      {
        // Integration suites talk to Postgres/S3 and need real Blob/FormData/sockets.
        //
        // The 5 s default budget is a unit-test budget. A single case here can
        // be a dozen round trips to a real database plus an object store, and
        // under the full run the unit project competes for the same CPU — a
        // suite that takes ~5 s alone has been measured at ~16 s under load.
        // Scoped to this project so unit tests keep the tight default.
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
