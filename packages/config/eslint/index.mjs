// Shared ESLint flat-config preset for the StudyHub monorepo.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/next-env.d.ts',
  'apps/api/src/generated/**',
  'docs/blueprint/**',
  // Deliberately rule-violating files used only by the boundaries meta-check.
  'tools/boundary-fixtures/modules/**',
];

export function studyhubEslintConfig() {
  return defineConfig(
    { ignores },
    js.configs.recommended,
    tseslint.configs.recommended,
    {
      languageOptions: { globals: { ...globals.node } },
      rules: {
        'no-console': 'error',
        eqeqeq: ['error', 'always'],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/no-explicit-any': 'error',
        // String-built SQL bypasses parameterisation (injection) and is never needed: use tagged $queryRaw.
        'no-restricted-properties': [
          'error',
          { property: '$queryRawUnsafe', message: 'Use the tagged $queryRaw template (parameterised).' },
          { property: '$executeRawUnsafe', message: 'Use the tagged $executeRaw template (parameterised).' },
        ],
      },
    },
    {
      // CommonJS configuration files (dependency-cruiser) legitimately use require().
      files: ['**/*.cjs'],
      languageOptions: { sourceType: 'commonjs' },
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      plugins: { '@next/next': nextPlugin },
      settings: { next: { rootDir: 'apps/web' } },
      languageOptions: { globals: { ...globals.browser } },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
      },
    },
    {
      // CLI tools and code generators legitimately write to stdout.
      files: [
        'tools/**/*.mjs',
        'packages/contracts/scripts/**',
        'apps/api/src/cli/**',
        'apps/web/scripts/**',
      ],
      rules: { 'no-console': 'off' },
    },
  );
}
