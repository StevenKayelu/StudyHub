// Runs the Next.js standalone server produced by `output: 'standalone'` (next.config.ts).
//   node scripts/standalone.mjs prepare   copy static assets into the standalone folder (runs after `next build`)
//   node scripts/standalone.mjs start     start the server (defaults 127.0.0.1:3000; override with HOSTNAME / PORT)
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// With outputFileTracingRoot at the monorepo root, Next mirrors the workspace layout here.
const standaloneAppDir = path.join(appDir, '.next', 'standalone', 'apps', 'web');
const serverPath = path.join(standaloneAppDir, 'server.js');

const command = process.argv[2];

if (command === 'prepare') {
  cpSync(path.join(appDir, '.next', 'static'), path.join(standaloneAppDir, '.next', 'static'), {
    recursive: true,
  });
  const publicDir = path.join(appDir, 'public');
  if (existsSync(publicDir)) {
    cpSync(publicDir, path.join(standaloneAppDir, 'public'), { recursive: true });
  }
  console.log('Standalone server prepared.');
} else if (command === 'start') {
  if (!existsSync(serverPath)) {
    console.error('No standalone build found. Run `pnpm build` first.');
    process.exit(1);
  }
  process.env.PORT ??= '3000';
  process.env.HOSTNAME ??= '127.0.0.1';
  await import(pathToFileURL(serverPath).href);
} else {
  console.error('Usage: node scripts/standalone.mjs <prepare|start>');
  process.exit(1);
}
