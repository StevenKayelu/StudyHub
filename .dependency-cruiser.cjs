/**
 * Module-boundary rules (blueprint 04 §5.2, 09 §7).
 * Enforced in CI by `pnpm boundaries`, which also proves these rules catch violations
 * by running them against tools/boundary-fixtures (see expect-violations.mjs).
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-internals-only-via-index',
      severity: 'error',
      comment: 'A module may use another module only through that module index.ts (its public surface).',
      from: { path: '(^|/)modules/([^/]+)/' },
      to: {
        path: '(^|/)modules/([^/]+)/',
        pathNot: ['(^|/)modules/$2/', '(^|/)modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'domain-is-framework-free',
      severity: 'error',
      comment: 'Domain code is plain TypeScript: no NestJS, Prisma, Fastify, pg or pg-boss imports.',
      from: { path: '(^|/)modules/[^/]+/domain/' },
      to: {
        path: [
          '^(@nestjs|@prisma|fastify|pg-boss|pg)(/|$)',
          'node_modules/(@nestjs|@prisma|fastify|pg-boss|pg)/',
        ],
      },
    },
    {
      name: 'web-does-not-import-api',
      severity: 'error',
      comment: 'The web app talks to the API over HTTP only; shared types come from packages/contracts.',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: [
        '(^|/)(dist|\\.next|\\.turbo|coverage|generated)/',
        '(^|/)node_modules/',
        '^tools/boundary-fixtures/',
      ],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.d.ts'],
    },
  },
};
