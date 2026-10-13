import { type NextRequest, NextResponse } from 'next/server';

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
  if (isInternal(pathname)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const rawHost = (request.headers.get('host') ?? '').trim().toLowerCase();
  const hostname = rawHost.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (!HOST.test(hostname)) {
    return new NextResponse('Bad request', { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', rawHost);

  if (process.env.MAINTENANCE_MODE === 'on' && !pathname.startsWith('/api/')) {
    const url = request.nextUrl.clone();
    url.pathname = '/_system/maintenance';
    return NextResponse.rewrite(url, {
      status: 503,
      request: { headers },
      headers: { 'retry-after': '600' },
    });
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next.js build assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
