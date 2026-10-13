import { AppError } from '../errors/app-error';

/**
 * Fixed-window counters per key, in process (04 §17.11: buckets per IP, per account and per tenant).
 * Single-instance only: with more than one API instance the effective limit multiplies, so a shared
 * store (PostgreSQL or Redis) replaces this before horizontal scaling. Bounded memory.
 */
export interface RateRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Counts one hit; returns seconds to wait when over the limit, otherwise null. */
  hit(key: string, rule: RateRule): number | null {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count > rule.limit ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : null;
  }

  /** Hits every key; throws RATE_LIMITED (with Retry-After) if any is over its limit. */
  enforce(checks: ReadonlyArray<readonly [key: string, rule: RateRule]>): void {
    let retryAfter = 0;
    for (const [key, rule] of checks) {
      const wait = this.hit(key, rule);
      if (wait !== null) retryAfter = Math.max(retryAfter, wait);
    }
    if (retryAfter > 0) {
      throw new AppError('RATE_LIMITED', {
        detail: `Too many attempts. Try again in ${retryAfter} seconds.`,
        extensions: { retryAfter },
      });
    }
  }

  /** Clears a key (e.g. the per-account sign-in counter after a successful sign-in). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Limits per action (PROPOSED values; see docs/design/m4-identity-realms.md). Per-IP limits are generous on
 * purpose: a whole school often shares one public address (NAT), so per-account and per-school limits do
 * the real work.
 */
export const RATE_RULES = {
  signInPerIp: { limit: 300, windowMs: 10 * MINUTE },
  signInPerAccount: { limit: 10, windowMs: 15 * MINUTE },
  signInPerTenant: { limit: 600, windowMs: MINUTE },
  registerPerIp: { limit: 60, windowMs: HOUR },
  registerPerTenant: { limit: 200, windowMs: HOUR },
  emailPerAccount: { limit: 3, windowMs: HOUR },
  emailPerIp: { limit: 60, windowMs: HOUR },
  tokenPerIp: { limit: 120, windowMs: 10 * MINUTE },
  consoleSignInPerIp: { limit: 10, windowMs: 15 * MINUTE },
  consoleSignInPerAccount: { limit: 5, windowMs: 15 * MINUTE },
  consoleTotpPerSession: { limit: 5, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateRule>;
