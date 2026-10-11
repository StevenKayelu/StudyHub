import { type NextRequest, NextResponse } from 'next/server';

/**
 * Request guard for school sites (blueprint 04 §6, §17.2; design §3.6). Runs once per request, on the
 * ORIGINAL path, before next.config rewrites map school hosts to the internal /_tenant/<host> route.
 *
 * - Direct requests to the internal /_tenant route are refused, so one host can never render another
 *   school's pages.
 * - Malformed Host headers are refused.
 * - X-Forwarded-Host is always overwritten with the real Host before anything reaches the API, so a
 *   client can't choose a school by sending that header through the web server (threat T3).
 */
const INTERNAL_PREFIX = '/_tenant';
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname === INTERNAL_PREFIX || pathname.startsWith(`${INTERNAL_PREFIX}/`)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const rawHost = (request.headers.get('host') ?? '').trim().toLowerCase();
  const hostname = rawHost.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (!HOST.test(hostname)) {
    return new NextResponse('Bad request', { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', rawHost);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next.js build assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
