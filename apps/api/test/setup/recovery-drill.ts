import { performance } from 'node:perf_hooks';

import { startTestDatabase, type TestDatabase } from './postgres-container';

/** Recovery rehearsal only: target is always newly allocated here, never a caller-supplied URL.
 * The backup stays inside ephemeral containers/memory and is not written to the working tree.
 * Infrastructure roles are provisioned by the real init scripts, separately from pg_dump.
 */
export async function restoreDisposableBackup(source: TestDatabase): Promise<{
  restored: TestDatabase;
  backupMs: number;
  restoreMs: number;
}> {
  const backupStart = performance.now();
  const dump = await source.container.exec(['pg_dump', '-U', 'postgres', '-d', 'studyhub', '--format=plain']);
  if (dump.exitCode !== 0) throw new Error(`Disposable backup failed: ${dump.stderr}`);
  const backupMs = performance.now() - backupStart;
  const restoreStart = performance.now();
  const restored = await startTestDatabase({ migrate: false });
  try {
    await restored.container.copyContentToContainer([{ content: dump.stdout, target: '/tmp/recovery.sql' }]);
    const result = await restored.container.exec([
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'studyhub',
      '-f',
      '/tmp/recovery.sql',
    ]);
    if (result.exitCode !== 0) throw new Error(`Disposable restore failed: ${result.stderr}`);
    return { restored, backupMs, restoreMs: performance.now() - restoreStart };
  } catch (error) {
    await restored.stop();
    throw error;
  }
}
