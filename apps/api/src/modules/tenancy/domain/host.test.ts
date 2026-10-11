import { describe, expect, it } from 'vitest';

import { normalizeHost, RESERVED_SLUGS, slugProblem } from './host';

describe('normalizeHost (T-ISO-10, unit)', () => {
  it.each([
    ['acme.localhost', 'acme.localhost'],
    ['ACME.Localhost', 'acme.localhost'],
    ['acme.localhost:3000', 'acme.localhost'],
    ['acme.localhost.', 'acme.localhost'],
    ['  acme.studyhub.app  ', 'acme.studyhub.app'],
    ['learn.my-school.ac.zm', 'learn.my-school.ac.zm'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'localhost',
    '127.0.0.1',
    '127.0.0.1:4000',
    '[::1]:3000',
    'acme_school.localhost',
    'acme.localhost:abc',
    'acme..localhost',
    '-acme.localhost',
    'acme.localhost/../beta',
    'acme.localhost\r\nx-injected: 1',
    `${'a'.repeat(64)}.localhost`,
  ])('rejects %j', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
});

describe('slugProblem (BR-50)', () => {
  it('accepts valid slugs', () => {
    expect(slugProblem('acme')).toBeNull();
    expect(slugProblem('beta-college')).toBeNull();
    expect(slugProblem('st-marys-2026')).toBeNull();
  });

  it('rejects bad formats', () => {
    for (const slug of ['ab', 'Acme', '-acme', 'acme-', 'acme_x', 'a'.repeat(31), 'acme.x']) {
      expect(slugProblem(slug)).toBe('FORMAT');
    }
  });

  it('rejects double hyphens and reserved words', () => {
    expect(slugProblem('acme--x')).toBe('DOUBLE_HYPHEN');
    for (const reserved of RESERVED_SLUGS) {
      if (reserved.length >= 3) expect(slugProblem(reserved)).toBe('RESERVED');
    }
  });
});
