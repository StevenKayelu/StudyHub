import { lightColors } from '@studyhub/ui/theme';
import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';

import { accentPair } from '../../../../lib/brand-assets';
import { tenantForRoute } from '../../../../lib/tenant';

/** GET /og.png: the Open Graph image template (paper, the school's name and its accent line). */
export async function GET(_request: Request, { params }: { params: Promise<{ host: string }> }) {
  const tenant = await tenantForRoute((await params).host);
  if (tenant === null) return new Response('Not found', { status: 404 });
  const t = await getTranslations('public.home');
  const { accent } = accentPair(tenant);
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 96,
        background: lightColors['bg-canvas'],
        color: lightColors['text-default'],
      }}
    >
      <div style={{ fontSize: 76, fontWeight: 700 }}>{tenant.branding.displayName}</div>
      <div style={{ fontSize: 36, marginTop: 16, color: lightColors['text-muted'] }}>{t('title')}</div>
      <div style={{ width: 240, height: 10, borderRadius: 5, marginTop: 48, background: accent }} />
    </div>,
    { width: 1200, height: 630, headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
