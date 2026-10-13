import { lightColors } from '@studyhub/ui/theme';

import { accentPair } from '../../../../lib/brand-assets';
import { tenantForRoute } from '../../../../lib/tenant';

/** GET /manifest.webmanifest: the school's installable app identity (F39, 04 §17.7). */
export async function GET(_request: Request, { params }: { params: Promise<{ host: string }> }) {
  const tenant = await tenantForRoute((await params).host);
  if (tenant === null) return new Response('Not found', { status: 404 });
  const name = tenant.branding.displayName;
  const manifest = {
    name,
    short_name: name.length <= 12 ? name : (name.split(/\s+/)[0] ?? name).slice(0, 12),
    id: '/',
    start_url: '/learn',
    scope: '/',
    display: 'standalone',
    background_color: lightColors['bg-canvas'],
    theme_color: accentPair(tenant).accent,
    lang: tenant.locales.defaultLocale,
    icons: [
      { src: '/icon/192', sizes: '192x192', type: 'image/png' },
      { src: '/icon/512', sizes: '512x512', type: 'image/png' },
      { src: '/mark.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  return Response.json(manifest, {
    headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' },
  });
}
