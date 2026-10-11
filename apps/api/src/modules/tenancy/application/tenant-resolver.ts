import { normalizeHost } from '../domain/host';

export type ResolvedTenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDING';

export interface ResolvedTenant {
  tenantId: string;
  status: ResolvedTenantStatus;
  primaryHost: string | null;
}

/** Looks a normalised host up in the database (implemented with the resolve_tenant() function). */
export interface TenantLookup {
  lookup(host: string): Promise<ResolvedTenant | null>;
}

interface CacheEntry {
  value: ResolvedTenant | null;
  expiresAt: number;
}

/**
 * Host → school resolution (design §3.6). The host is normalised first, so malformed or hostile
 * values never reach the database. Results (including "unknown") are cached in-process for a short
 * time, keyed by the normalised host. This cache maps hosts to tenants; it never holds tenant data.
 */
export class TenantResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly lookup: TenantLookup,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  async resolve(rawHost: string | undefined): Promise<ResolvedTenant | null> {
    const host = normalizeHost(rawHost);
    if (host === null) return null;

    const cached = this.cache.get(host);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.value;

    const value = await this.lookup.lookup(host);
    if (this.cache.size >= this.maxEntries) this.cache.clear(); // bounded: random hosts can't exhaust memory
    this.cache.set(host, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** Drop cached resolutions (all, or one host) after a domain or status change. */
  invalidate(host?: string): void {
    if (host === undefined) {
      this.cache.clear();
      return;
    }
    const normalised = normalizeHost(host);
    if (normalised !== null) this.cache.delete(normalised);
  }
}
