import { describe, expect, it } from 'vitest';

import { type ResolvedTenant, type TenantLookup, TenantResolver } from './tenant-resolver';

const ACME: ResolvedTenant = {
  tenantId: '0192a0c1-0000-7000-8000-00000000000a',
  status: 'ACTIVE',
  primaryHost: 'acme.localhost',
  redirect: false,
};

function fakeLookup(known: Record<string, ResolvedTenant>) {
  const calls: string[] = [];
  const lookup: TenantLookup = {
    async lookup(host) {
      calls.push(host);
      return known[host] ?? null;
    },
  };
  return { lookup, calls };
}

describe('TenantResolver', () => {
  it('resolves a known host after normalising it', async () => {
    const { lookup, calls } = fakeLookup({ 'acme.localhost': ACME });
    const resolver = new TenantResolver(lookup);
    expect(await resolver.resolve('ACME.localhost:3000')).toEqual(ACME);
    expect(calls).toEqual(['acme.localhost']);
  });

  it('never queries the database for a malformed host', async () => {
    const { lookup, calls } = fakeLookup({});
    const resolver = new TenantResolver(lookup);
    expect(await resolver.resolve("acme.localhost'; DROP TABLE tenant;--")).toBeNull();
    expect(await resolver.resolve(undefined)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('caches hits and misses until the TTL expires', async () => {
    let clock = 0;
    const { lookup, calls } = fakeLookup({ 'acme.localhost': ACME });
    const resolver = new TenantResolver(lookup, 1000, () => clock);
    await resolver.resolve('acme.localhost');
    await resolver.resolve('nope.localhost');
    await resolver.resolve('acme.localhost');
    await resolver.resolve('nope.localhost');
    expect(calls).toEqual(['acme.localhost', 'nope.localhost']);
    clock = 1001;
    await resolver.resolve('acme.localhost');
    expect(calls).toEqual(['acme.localhost', 'nope.localhost', 'acme.localhost']);
  });

  it('invalidates a host on demand', async () => {
    const { lookup, calls } = fakeLookup({ 'acme.localhost': ACME });
    const resolver = new TenantResolver(lookup);
    await resolver.resolve('acme.localhost');
    resolver.invalidate('ACME.localhost');
    await resolver.resolve('acme.localhost');
    expect(calls).toEqual(['acme.localhost', 'acme.localhost']);
  });
});
