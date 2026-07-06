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
};

export default nextConfig;
