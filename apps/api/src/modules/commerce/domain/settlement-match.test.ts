import { describe, expect, it } from 'vitest';

import { type LocalPayment, matchSettlement, readStatementCsv } from './settlement-match';

const paid = (reference: string, amountMinor: number, extra: Partial<LocalPayment> = {}): LocalPayment => ({
  reference,
  paymentId: `p-${reference}`,
  amountMinor,
  currency: 'ZMW',
  recordedPaid: true,
  ...extra,
});

describe('settlement matching (W7)', () => {
  it('matches equal amounts and reports every kind of difference', () => {
    const result = matchSettlement(
      [paid('A', 100), paid('B', 200), paid('C', 300), paid('D', 50, { recordedPaid: false })],
      [
        { reference: 'A', amountMinor: 100, currency: 'ZMW' },
        { reference: 'B', amountMinor: 150, currency: 'ZMW' },
        { reference: 'D', amountMinor: 50, currency: 'ZMW' },
        { reference: 'X', amountMinor: 75, currency: 'ZMW' },
      ],
    );
    expect(result.matched).toBe(1);
    expect(result.items.map((i) => [i.reference, i.kind, i.paymentId])).toEqual([
      ['B', 'AMOUNT_MISMATCH', 'p-B'],
      ['D', 'MISSING_LOCAL', 'p-D'],
      ['X', 'MISSING_LOCAL', null],
      ['C', 'MISSING_PROVIDER', 'p-C'],
    ]);
  });

  it('flags a currency difference and a duplicate settlement', () => {
    const result = matchSettlement(
      [paid('A', 100)],
      [
        { reference: 'A', amountMinor: 100, currency: 'USD' },
        { reference: 'A', amountMinor: 100, currency: 'USD' },
      ],
    );
    expect(result.matched).toBe(0);
    expect(result.items.map((i) => i.kind)).toEqual(['AMOUNT_MISMATCH', 'AMOUNT_MISMATCH']);
    expect(result.items[1]?.reference).toBe('A#dup2');
  });

  it('reads the CSV template, skipping unsettled rows and reporting bad lines', () => {
    expect(
      readStatementCsv([
        ['reference', 'amount_minor', 'currency', 'status', 'date'],
        ['A', '100', 'zmw', 'SUCCEEDED', '2026-10-01'],
        ['B', '5', 'ZMW', 'FAILED', '2026-10-01'],
      ]),
    ).toEqual({ ok: true, transactions: [{ reference: 'A', amountMinor: 100, currency: 'ZMW' }] });
    expect(readStatementCsv([['ref', 'amount']])).toMatchObject({ ok: false });
    expect(
      readStatementCsv([
        ['reference', 'amount_minor', 'currency'],
        ['A', '1.5', 'ZMW'],
      ]),
    ).toEqual({ ok: false, errors: [{ line: 2, message: 'amount_minor must be a whole number' }] });
  });
});
