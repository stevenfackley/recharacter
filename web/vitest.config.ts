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
        extends: true,
        test: { name: 'integration', include: ['tests/**/*.test.ts'], environment: 'node' },
      },
    ],
  },
})
