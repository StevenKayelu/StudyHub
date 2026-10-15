import { describe, expect, it } from 'vitest';

import { CircuitBreakers } from './circuit-breaker';

describe('circuit breakers per payment account (04 §7.2, 07 M8 AC 3)', () => {
  it('opens after 5 failures in a minute, for that account only, and closes after 30 s', () => {
    let now = 0;
    const breakers = new CircuitBreakers(undefined, () => now);
    for (let i = 0; i < 4; i += 1) breakers.recordFailure('school-b');
    expect(breakers.isOpen('school-b')).toBe(false);
    breakers.recordFailure('school-b');
    expect(breakers.isOpen('school-b')).toBe(true);
    expect(breakers.isOpen('school-a')).toBe(false);
    now = 29_999;
    expect(breakers.isOpen('school-b')).toBe(true);
    now = 30_000;
    expect(breakers.isOpen('school-b')).toBe(false);
  });

  it('forgets old failures and resets on success', () => {
    let now = 0;
    const breakers = new CircuitBreakers(undefined, () => now);
    for (let i = 0; i < 4; i += 1) breakers.recordFailure('a');
    now = 61_000;
    breakers.recordFailure('a');
    expect(breakers.isOpen('a')).toBe(false);
    for (let i = 0; i < 3; i += 1) breakers.recordFailure('a');
    breakers.recordSuccess('a');
    breakers.recordFailure('a');
    expect(breakers.isOpen('a')).toBe(false);
  });
});
