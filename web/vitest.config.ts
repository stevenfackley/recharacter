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
