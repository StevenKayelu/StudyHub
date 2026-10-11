import { getSystemStatus } from '../lib/server-api';

// Always reflect the live state; never serve a cached status.
export const dynamic = 'force-dynamic';

export default async function SystemStatusPage() {
  const status = await getSystemStatus();

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
      <h1>StudyHub — system status</h1>
      <p>Engineering foundation (Milestone 1). This page only reports whether the services are running.</p>
      <dl>
        <dt>API</dt>
        <dd data-testid="api-status">{status.api}</dd>
        <dt>Database</dt>
        <dd data-testid="database-status">{status.database}</dd>
        <dt>Version</dt>
        <dd data-testid="api-version">{status.version ?? 'unknown'}</dd>
      </dl>
    </main>
  );
}
