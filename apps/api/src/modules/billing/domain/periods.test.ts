import { describe, expect, it } from 'vitest';

import { applyBps, mulDivHalfUp } from './money';
import { clip, cycleContaining, daysIn } from './periods';

describe('money arithmetic', () => {
  it('rounds half up to the minor unit, in integers', () => {
    expect(mulDivHalfUp(100n, 1n, 3n)).toBe(33n);
    expect(mulDivHalfUp(100n, 2n, 3n)).toBe(67n);
    expect(mulDivHalfUp(5n, 1n, 2n)).toBe(3n);
    expect(applyBps(12_345n, 250)).toBe(309n); // 308.625 → 309
    expect(applyBps(10_000_000_000_000_000n, 1)).toBe(1_000_000_000_000n); // no float overflow
  });

  it('refuses negative values, a zero denominator and out-of-range bps', () => {
    expect(() => mulDivHalfUp(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulDivHalfUp(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => applyBps(1n, 10_001)).toThrow(RangeError);
    expect(() => applyBps(1n, 1.5)).toThrow(RangeError);
  });
});

describe('billing periods', () => {
  it('finds the monthly cycle on the anchor day', () => {
    expect(cycleContaining('2027-03-20', 'MONTH', 15, '2027-01-15')).toEqual({
      start: '2027-03-15',
      end: '2027-04-15',
    });
    expect(cycleContaining('2027-03-10', 'MONTH', 15, '2027-01-15')).toEqual({
      start: '2027-02-15',
      end: '2027-03-15',
    });
  });

  it('counts quarters and years from the contract’s first cycle, not from January', () => {
    expect(cycleContaining('2027-06-01', 'QUARTER', 1, '2027-02-01')).toEqual({
      start: '2027-05-01',
      end: '2027-08-01',
    });
    expect(cycleContaining('2028-01-31', 'YEAR', 1, '2027-02-01')).toEqual({
      start: '2027-02-01',
      end: '2028-02-01',
    });
    // A contract starting mid-cycle belongs to the cycle on the anchor before it.
    expect(cycleContaining('2027-01-20', 'MONTH', 1, '2027-01-20')).toEqual({
      start: '2027-01-01',
      end: '2027-02-01',
    });
  });

  it('clips a cycle to the contract window and counts days end-exclusive', () => {
    const cycle = { start: '2027-01-01', end: '2027-02-01' };
    expect(daysIn(cycle)).toBe(31);
    expect(clip(cycle, '2027-01-20', null)).toEqual({ start: '2027-01-20', end: '2027-02-01' });
    expect(clip(cycle, '2026-06-01', '2027-01-11')).toEqual({ start: '2027-01-01', end: '2027-01-11' });
    expect(clip(cycle, '2027-02-01', null)).toBeNull();
    expect(daysIn({ start: '2028-02-01', end: '2028-03-01' })).toBe(29); // leap year
  });

  it('refuses impossible days and anchors', () => {
    expect(() => cycleContaining('2027-02-30', 'MONTH', 1, '2027-01-01')).toThrow(RangeError);
    expect(() => cycleContaining('2027-02-01', 'MONTH', 29, '2027-01-01')).toThrow(RangeError);
  });
});
