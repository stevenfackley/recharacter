import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  /* config options here */
  // Lean production image: next build emits .next/standalone (self-contained
  // server.js + pruned node_modules) consumed by web/Dockerfile.
  output: "standalone",
  // Pin the workspace root: a stray package-lock.json in the user's home
  // directory (outside this repo) otherwise makes Turbopack's root
  // inference ambiguous and prints a warning on every build.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // The floating dev-tools button is a fixed overlay that sits ON TOP of page
  // content and can intercept clicks (it was eating the intake file-input's
  // click). Dev-only UI; disabling it has zero production impact.
  devIndicators: false,
  // Server actions default to a 1 MB body limit, which silently breaks the
  // document-upload flow for real DD-214 scans (typically 2-10 MB). 16 MB =
  // the 15 MB app-level cap plus multipart overhead; the action still enforces
  // the user-facing 15 MB limit with a friendly error.
  experimental: {
    serverActions: {
      bodySizeLimit: '16mb',
    },
  },
  // The packet route reads Noto Serif TTFs at module load via
  // fs.readFileSync (see web/src/lib/packet/render.ts) rather than
  // `import`ing them, so Next's file tracer doesn't discover them on its
  // own — without this, `.next/standalone` ships without the fonts and the
  // route 500s in production even though it works in `next dev`.
  outputFileTracingIncludes: {
    '/api/packet': ['./src/lib/packet/fonts/**/*'],
  },
  // Baseline security headers on every response. Referrer-Policy is the one that
  // is not boilerplate here: case URLs carry ?error= codes and ?session_id=, and
  // a Referer header would hand those — plus the fact that this veteran is on a
  // discharge-upgrade page at all — to every third-party host they click through
  // to. no-referrer sends nothing, anywhere.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
