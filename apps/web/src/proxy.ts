import { type NextRequest, NextResponse } from 'next/server';

import { webContentSecurityPolicy, webSecurityHeaders } from './lib/security-headers';

/**
 * Request guard (blueprint 04 §6, §17.2; design §3.6). Runs once per request, on the ORIGINAL path,
 * before next.config rewrites map hosts to the internal /_tenant/<host> and /_console routes.
 *
 * - Direct requests to internal routes are refused, so one host can never render another school's
 *   pages, and a school host can never render the console.
 * - Malformed Host headers are refused.
 * - X-Forwarded-Host is always overwritten with the real Host before anything reaches the API, so a
 *   client can't choose a school by sending that header through the web server (threat T3).
 * - MAINTENANCE_MODE=on serves the maintenance page (S-X04) with 503 for every page request.
 */
const INTERNAL_PREFIXES = ['/_tenant', '/_console', '/_system'];
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isInternal(pathname: string): boolean {
  return INTERNAL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const headers = new Headers(request.headers);
  // A client must never choose the nonce or the policy consumed by Next's renderer.
  headers.delete('x-nonce');
  headers.delete('content-security-policy');
  const rawHost = (request.headers.get('host') ?? '').trim().toLowerCase();
  const hostname = rawHost.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  const localHost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';
  const responseHeaders = new Headers(webSecurityHeaders(process.env.NODE_ENV === 'production'));
  // API responses carry the API's own policy (including its development hosted-card HTML).
  if (!(pathname === '/api' || pathname.startsWith('/api/'))) {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const csp = webContentSecurityPolicy(nonce, process.env.NODE_ENV === 'development', localHost);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    responseHeaders.set('content-security-policy', csp);
    // Never cache HTML with a nonce and replay it under another response's policy.
    // The versioned theme handler returns CSS, contains no nonce and owns its cache policy.
    // Keep it behind the same host guard rather than excluding it from the proxy matcher.
    if (!/^\/theme\/[^/]+\/[^/]+\.css$/.test(pathname)) {
      responseHeaders.set('cache-control', 'private, no-store');
    }
  }
  if (isInternal(pathname)) {
    return new NextResponse('Not found', { status: 404, headers: responseHeaders });
  }

  if (!HOST.test(hostname)) {
    return new NextResponse('Bad request', { status: 400, headers: responseHeaders });
  }

  headers.set('x-forwarded-host', rawHost);
  // The original path (before rewrites), for "return to" after sign-in. Client values are overwritten.
  headers.set('x-studyhub-path', `${pathname}${request.nextUrl.search}`.slice(0, 2048));

  if (process.env.MAINTENANCE_MODE === 'on' && !pathname.startsWith('/api/')) {
    // Native URL preserves the server origin; next.config disables proxy URL canonicalization.
    const url = new URL(request.url);
    url.pathname = '/_system/maintenance';
    responseHeaders.set('retry-after', '600');
    return NextResponse.rewrite(url, {
      status: 503,
      request: { headers },
      headers: responseHeaders,
    });
  }
  return NextResponse.next({ request: { headers }, headers: responseHeaders });
}

export const config = {
  // Everything except Next.js build assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
