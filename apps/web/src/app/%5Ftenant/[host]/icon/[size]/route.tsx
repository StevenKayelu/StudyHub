import { ImageResponse } from 'next/og';

import { accentPair, monogram } from '../../../../../lib/brand-assets';
import { tenantForRoute } from '../../../../../lib/tenant';

const SIZES = new Set([192, 512]);

/** GET /icon/192 and /icon/512: PNG app icons for the PWA manifest and Apple touch icon. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ host: string; size: string }> },
) {
  const { host, size: raw } = await params;
  const size = Number(raw);
  const tenant = await tenantForRoute(host);
  if (tenant === null || !SIZES.has(size)) return new Response('Not found', { status: 404 });
  const { accent, onAccent } = accentPair(tenant);
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: accent,
        color: onAccent,
        fontSize: size * 0.56,
        fontWeight: 700,
      }}
    >
      {monogram(tenant)}
    </div>,
    { width: size, height: size, headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
