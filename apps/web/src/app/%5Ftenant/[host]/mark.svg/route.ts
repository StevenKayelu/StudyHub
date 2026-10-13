import { monogramSvg } from '../../../../lib/brand-assets';
import { tenantForRoute } from '../../../../lib/tenant';

/** GET /mark.svg: the school's favicon (a monogram in its accent until it uploads one). */
export async function GET(_request: Request, { params }: { params: Promise<{ host: string }> }) {
  const tenant = await tenantForRoute((await params).host);
  if (tenant === null) return new Response('Not found', { status: 404 });
  return new Response(monogramSvg(tenant), {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
