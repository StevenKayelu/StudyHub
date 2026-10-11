import { notFound } from 'next/navigation';

import { getTenantBootstrap } from '../../../lib/server-api';

// M2 renders live data; per-host ISR caching (keyed by this /_tenant/<host> path) arrives with real pages.
export const dynamic = 'force-dynamic';

interface TenantPageProps {
  params: Promise<{ host: string }>;
}

/** School site placeholder (M2): proves host → school resolution end to end. Real pages arrive in M3+. */
export default async function TenantHomePage({ params }: TenantPageProps) {
  const { host } = await params;
  const tenant = await getTenantBootstrap(decodeURIComponent(host));
  if (tenant === null) notFound();

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '40rem',
        margin: '0 auto',
        padding: '2rem 1rem',
        lineHeight: 1.5,
      }}
    >
      <h1 data-testid="tenant-name">{tenant.name}</h1>
      <p>
        This school site is a placeholder from the tenancy milestone (M2). Status:{' '}
        <span data-testid="tenant-status">{tenant.status}</span>
      </p>
    </main>
  );
}
