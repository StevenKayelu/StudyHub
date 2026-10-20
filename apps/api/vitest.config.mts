import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** SWC compiles tests so NestJS decorator metadata (constructor injection) works under Vitest. */
export const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    name: 'api-unit',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/setup/**/*.test.ts'],
  },
});
