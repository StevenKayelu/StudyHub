/**
 * Settlement reconciliation (W7): what StudyHub recorded as paid vs what the provider settled, matched
 * by our payment reference. Framework-free.
 */
export interface LocalPayment {
  reference: string;
  paymentId: string;
  /** What the payment was expected to collect. */
  amountMinor: number;
  currency: string;
  /** Whether StudyHub recorded it as paid (SUCCEEDED or REFUNDED) in the period. */
  recordedPaid: boolean;
}

export interface SettledTransaction {
  reference: string;
  amountMinor: number;
  currency: string;
}

export interface MatchItem {
  reference: string;
  kind: 'MISSING_LOCAL' | 'MISSING_PROVIDER' | 'AMOUNT_MISMATCH';
  paymentId: string | null;
  localAmountMinor: number | null;
  providerAmountMinor: number | null;
  currency: string;
}

export interface MatchResult {
  matched: number;
  items: MatchItem[];
}

/**
 * - matched: both sides have the reference with the same amount and currency;
 * - AMOUNT_MISMATCH: both have it, amounts or currencies differ;
 * - MISSING_LOCAL: the provider settled money StudyHub didn't record as paid (paymentId set if a
 *   payment with that reference exists in another state, e.g. still pending);
 * - MISSING_PROVIDER: StudyHub recorded a payment the provider didn't settle.
 * A reference appearing twice in the provider list counts once; the duplicate is a mismatch.
 */
export function matchSettlement(
  local: readonly LocalPayment[],
  provider: readonly SettledTransaction[],
): MatchResult {
  const byReference = new Map(local.map((payment) => [payment.reference, payment]));
  const seen = new Set<string>();
  const items: MatchItem[] = [];
  let matched = 0;
  for (const tx of provider) {
    const payment = byReference.get(tx.reference);
    if (seen.has(tx.reference)) {
      items.push({
        reference: `${tx.reference}#dup${items.filter((i) => i.reference.startsWith(tx.reference)).length + 1}`,
        kind: 'AMOUNT_MISMATCH',
        paymentId: payment?.paymentId ?? null,
        localAmountMinor: null,
        providerAmountMinor: tx.amountMinor,
        currency: tx.currency,
      });
      continue;
    }
    seen.add(tx.reference);
    if (payment === undefined || !payment.recordedPaid) {
      items.push({
        reference: tx.reference,
        kind: 'MISSING_LOCAL',
        paymentId: payment?.paymentId ?? null,
        localAmountMinor: payment?.amountMinor ?? null,
        providerAmountMinor: tx.amountMinor,
        currency: tx.currency,
      });
    } else if (payment.amountMinor !== tx.amountMinor || payment.currency !== tx.currency) {
      items.push({
        reference: tx.reference,
        kind: 'AMOUNT_MISMATCH',
        paymentId: payment.paymentId,
        localAmountMinor: payment.amountMinor,
        providerAmountMinor: tx.amountMinor,
        currency: tx.currency,
      });
    } else {
      matched += 1;
    }
  }
  for (const payment of local) {
    if (payment.recordedPaid && !seen.has(payment.reference)) {
      items.push({
        reference: payment.reference,
        kind: 'MISSING_PROVIDER',
        paymentId: payment.paymentId,
        localAmountMinor: payment.amountMinor,
        providerAmountMinor: null,
        currency: payment.currency,
      });
    }
  }
  return { matched, items };
}

export type CsvStatementResult =
  | { ok: true; transactions: SettledTransaction[] }
  | { ok: false; errors: { line: number; message: string }[] };

/**
 * Reads a provider statement CSV with the template header `reference,amount_minor,currency,status,date`.
 * Only SUCCEEDED (or PAID/COMPLETED) rows are settlements; other statuses are skipped.
 */
export function readStatementCsv(rows: readonly string[][]): CsvStatementResult {
  const [header, ...body] = rows;
  const columns = (header ?? []).map((cell) => cell.trim().toLowerCase());
  const index = (name: string) => columns.indexOf(name);
  const missing = ['reference', 'amount_minor', 'currency'].filter((name) => index(name) === -1);
  if (missing.length > 0) {
    return { ok: false, errors: [{ line: 1, message: `Missing column(s): ${missing.join(', ')}` }] };
  }
  const errors: { line: number; message: string }[] = [];
  const transactions: SettledTransaction[] = [];
  body.forEach((row, offset) => {
    const line = offset + 2;
    const status = (row[index('status')] ?? 'SUCCEEDED').trim().toUpperCase();
    if (!['SUCCEEDED', 'SUCCESS', 'PAID', 'COMPLETED', ''].includes(status)) return;
    const reference = (row[index('reference')] ?? '').trim();
    const amount = Number((row[index('amount_minor')] ?? '').trim());
    const currency = (row[index('currency')] ?? '').trim().toUpperCase();
    if (reference === '' || reference.length > 120) errors.push({ line, message: 'Reference is missing' });
    else if (!Number.isSafeInteger(amount) || amount < 0)
      errors.push({ line, message: 'amount_minor must be a whole number' });
    else if (!/^[A-Z]{3}$/.test(currency)) errors.push({ line, message: 'currency must be a 3-letter code' });
    else transactions.push({ reference, amountMinor: amount, currency });
  });
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, transactions };
}
