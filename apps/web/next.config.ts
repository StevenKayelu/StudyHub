import path from 'node:path';

import type { NextConfig } from 'next';

/** Where the web server reaches the API (server-side and through the /api rewrite). */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

/**
 * Hosts that serve the platform itself (the system status page) rather than a school site.
 * Read at build time: rewrites are compiled into the build.
 */
const platformHosts = (process.env.PLATFORM_HOSTS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter((host) => host.length > 0);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const notPlatformHost = platformHosts.map((host) => ({ type: 'host' as const, value: escapeRegex(host) }));
const schoolHost = { type: 'host' as const, value: '(?<schoolHost>.+)' };

const nextConfig: NextConfig = {
  output: 'standalone',
  // The monorepo root, so standalone output traces workspace packages correctly.
  outputFileTracingRoot: path.resolve(process.cwd(), '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return {
      // School sites: every non-platform host is served by the internal /_tenant/<host> route, so every
      // rendered (and later cached) page is keyed by its host. Runs after src/proxy.ts, which has already
      // refused direct /_tenant requests and fixed X-Forwarded-Host.
      beforeFiles: [
        { source: '/', has: [schoolHost], missing: notPlatformHost, destination: '/_tenant/:schoolHost' },
        {
          source: '/:path((?!api(?:/|$)|_next/|_tenant(?:/|$)).+)',
          has: [schoolHost],
          missing: notPlatformHost,
          destination: '/_tenant/:schoolHost/:path',
        },
      ],
      afterFiles: [],
      // Same-origin API access. School-scoped routes keep their /api/v1 prefix; the platform probes are
      // exposed as /api/healthz and /api/readyz.
      fallback: [
        { source: '/api/v1/:path*', destination: `${apiInternalUrl}/api/v1/:path*` },
        { source: '/api/:path*', destination: `${apiInternalUrl}/:path*` },
      ],
    };
  },
};

export default nextConfig;
