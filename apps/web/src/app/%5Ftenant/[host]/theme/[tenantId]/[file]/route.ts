import { tenantForRoute, tenantThemeCss } from '../../../../../../lib/tenant';

interface ThemeRouteContext {
  params: Promise<{ host: string; tenantId: string; file: string }>;
}

/**
 * GET /theme/{tenantId}/{brandingVersion}.css (04 §17.7): the school's theme, immutable per version.
 * Served only on the school's own host and only for its current version, so a URL can never be used to
 * fetch another school's theme or a stale one into a long-lived cache.
 */
export async function GET(_request: Request, { params }: ThemeRouteContext): Promise<Response> {
  const { host, tenantId, file } = await params;
  const tenant = await tenantForRoute(host);
  const version = /^(\d{1,9})\.css$/.exec(file)?.[1];
  if (tenant === null || tenant.id !== tenantId || version !== String(tenant.branding.version)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(tenantThemeCss(tenant), {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
