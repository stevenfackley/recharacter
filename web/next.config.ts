import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  /* config options here */
  // Pin the workspace root: a stray package-lock.json in the user's home
  // directory (outside this repo) otherwise makes Turbopack's root
  // inference ambiguous and prints a warning on every build.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Server actions default to a 1 MB body limit, which silently breaks the
  // document-upload flow for real DD-214 scans (typically 2-10 MB). 16 MB =
  // the 15 MB app-level cap plus multipart overhead; the action still enforces
  // the user-facing 15 MB limit with a friendly error.
  experimental: {
    serverActions: {
      bodySizeLimit: '16mb',
    },
  },
};

export default nextConfig;
