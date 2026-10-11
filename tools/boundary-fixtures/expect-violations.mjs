// Proves the boundary rules actually catch violations: runs dependency-cruiser against the
// deliberately broken fixtures and fails unless every expected rule fires.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
// dependency-cruiser does not export its package.json, so locate the root-level install directly.
const cliPath = path.join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');

const expectedRules = ['module-internals-only-via-index', 'domain-is-framework-free'];

const result = spawnSync(
  process.execPath,
  [
    cliPath,
    'tools/boundary-fixtures/modules',
    '--config',
    'tools/boundary-fixtures/dependency-cruiser.fixtures.cjs',
    '--output-type',
    'json',
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

if (!result.stdout) {
  console.error('boundaries meta-check: dependency-cruiser produced no output.', result.stderr);
  process.exit(1);
}

const report = JSON.parse(result.stdout);
const fired = new Set(report.summary.violations.map((violation) => violation.rule.name));
const missing = expectedRules.filter((rule) => !fired.has(rule));

if (missing.length > 0) {
  console.error(
    `boundaries meta-check FAILED: rules that missed their fixture violation: ${missing.join(', ')}`,
  );
  process.exit(1);
}
console.log(`boundaries meta-check passed: violations detected for ${expectedRules.join(', ')}`);
