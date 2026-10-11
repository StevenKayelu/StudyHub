// Secret scan with gitleaks, run through Docker so no local install is needed.
//   node tools/gitleaks.mjs        scan the working tree (used by `pnpm verify`)
//   node tools/gitleaks.mjs --git  scan the full git history (used in CI)
// Findings are redacted in the output. Exit code is non-zero when anything is found.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GITLEAKS_IMAGE = 'zricethezav/gitleaks:v8.30.1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--git') ? 'git' : 'dir';

const args = [
  'run',
  '--rm',
  '-v',
  `${root}:/repo`,
  GITLEAKS_IMAGE,
  mode,
  '/repo',
  '--config',
  '/repo/.gitleaks.toml',
  '--redact',
  '--no-banner',
  '--exit-code',
  '1',
];

const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) {
  console.error(`secret scan could not start Docker: ${result.error.message}`);
  console.error('Start Docker Desktop and retry.');
  process.exit(2);
}
process.exit(result.status ?? 1);
