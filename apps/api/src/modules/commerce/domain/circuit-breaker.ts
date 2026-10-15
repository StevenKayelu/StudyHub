/**
 * Circuit breakers keyed by payment account (04 §7.2, §17.10): 5 failures within a minute open the
 * breaker for 30 s, during which calls for THAT account fail fast with "payments temporarily
 * unavailable". Keys never mix accounts, so one school's bad credentials or outage can't block
 * another school's payments (07 M8 AC 3). In-process state; each API and worker process has its own.
 */
export class CircuitBreakers {
  private readonly failures = new Map<string, number[]>();
  private readonly openUntil = new Map<string, number>();

  constructor(
    private readonly options: { threshold: number; windowMs: number; openMs: number } = {
      threshold: 5,
      windowMs: 60_000,
      openMs: 30_000,
    },
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(key: string): boolean {
    const until = this.openUntil.get(key);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.openUntil.delete(key);
      this.failures.delete(key);
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  recordFailure(key: string): void {
    const now = this.now();
    const recent = (this.failures.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= this.options.threshold) this.openUntil.set(key, now + this.options.openMs);
  }
}
