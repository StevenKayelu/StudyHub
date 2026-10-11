import { describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error';
import { tenantCacheKey } from './cache-key';

const TENANT_A = '0192a0c1-0000-7000-8000-00000000000a';
const TENANT_B = '0192a0c1-0000-7000-8000-00000000000b';

describe('tenantCacheKey (T-ISO-20)', () => {
  it('prefixes every key with the tenant id', () => {
    expect(tenantCacheKey(TENANT_A, 'course', 'biology')).toBe(`t:${TENANT_A}:course:biology`);
  });

  it('gives different tenants different keys for the same resource', () => {
    expect(tenantCacheKey(TENANT_A, 'course', 'biology')).not.toBe(
      tenantCacheKey(TENANT_B, 'course', 'biology'),
    );
  });

  it('refuses a missing tenant id', () => {
    expect(() => tenantCacheKey(undefined, 'course')).toThrow(AppError);
  });

  it('refuses a malformed tenant id', () => {
    expect(() => tenantCacheKey('acme', 'course')).toThrow(AppError);
    expect(() => tenantCacheKey('', 'course')).toThrow(AppError);
  });

  it('refuses key parts that could forge another key', () => {
    expect(() => tenantCacheKey(TENANT_A)).toThrow();
    expect(() => tenantCacheKey(TENANT_A, `x:t:${TENANT_B}`)).toThrow();
    expect(() => tenantCacheKey(TENANT_A, '')).toThrow();
  });
});
