import path from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

import { consoleHosts, platformHosts } from './src/lib/hosts';
import { cspOrigins, webSecurityHeaders } from './src/lib/security-headers';

for (const key of [
  'WEB_CSP_CONNECT_ORIGINS',
  'WEB_CSP_IMAGE_ORIGINS',
  'WEB_CSP_MEDIA_ORIGINS',
  'WEB_CSP_FRAME_ORIGINS',
]) {
  cspOrigins(process.env[key]);
}

/** Where the web server reaches the API (server-side and through the /api rewrite). */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Host routing, read at build time (rewrites are compiled into the build):
 * platform hosts serve the status page, console hosts the platform console (/_console), and every
 * other host is a school site (/_tenant/<host>).
 */
const notSchoolHost = [...platformHosts(), ...consoleHosts()].map((host) => ({
  type: 'host' as const,
  value: escapeRegex(host),
}));
const schoolHost = { type: 'host' as const, value: '(?<schoolHost>.+)' };
const consoleHost = {
  type: 'host' as const,
  value: consoleHosts().map(escapeRegex).join('|') || '(?!)',
};

/** Paths never rewritten: the API proxy, Next.js assets and the internal route prefixes. */
const ROUTED_PATH = '/:path((?!api(?:/|$)|_next/|_tenant(?:/|$)|_console(?:/|$)|_system(?:/|$)).+)';

const nextConfig: NextConfig = {
  distDir: process.env.STUDYHUB_E2E_ISOLATED === '1' ? '.next-e2e' : '.next',
  output: 'standalone',
  // The monorepo root, so standalone output traces workspace packages correctly.
  outputFileTracingRoot: path.resolve(process.cwd(), '..', '..'),
  poweredByHeader: false,
  // Keep standalone loopback rewrites internal: Next's localhost canonicalization otherwise turns
  // the maintenance rewrite into a second HTTP request rejected by the internal-route guard.
  skipProxyUrlNormalize: true,
  reactStrictMode: true,
  // Import only the design-system modules a route uses (keeps Radix out of pages that don't need it).
  experimental: { optimizePackageImports: ['@studyhub/ui', 'lucide-react'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: Object.entries(webSecurityHeaders(process.env.NODE_ENV === 'production')).map(
          ([key, value]) => ({ key, value }),
        ),
      },
    ];
  },
  async rewrites() {
    return {
      // School sites: every non-platform host is served by the internal /_tenant/<host> route, so every
      // rendered (and later cached) page is keyed by its host. Runs after src/proxy.ts, which has already
      // refused direct requests to internal routes and fixed X-Forwarded-Host.
      beforeFiles: [
        { source: '/', has: [consoleHost], destination: '/_console' },
        { source: ROUTED_PATH, has: [consoleHost], destination: '/_console/:path' },
        { source: '/', has: [schoolHost], missing: notSchoolHost, destination: '/_tenant/:schoolHost' },
        {
          source: ROUTED_PATH,
          has: [schoolHost],
          missing: notSchoolHost,
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

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
