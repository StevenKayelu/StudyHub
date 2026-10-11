import path from 'node:path';

import type { NextConfig } from 'next';

/** Where the web server reaches the API (server-side and through the /api rewrite). */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // The monorepo root, so standalone output traces workspace packages correctly.
  outputFileTracingRoot: path.resolve(process.cwd(), '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    // Development convenience: browser calls to /api/* reach the API on the same origin.
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/:path*` }];
  },
};

export default nextConfig;
