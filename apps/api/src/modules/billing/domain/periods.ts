/**
 * Billing periods (docs/design/saas-billing.md). Dates are calendar days in UTC, written `YYYY-MM-DD`;
 * a span is [start, end): the start day is included, the end day is not. A cycle starts on the
 * contract's anchor day (1–28, so every month has it) and lasts one, three or twelve months.
 */
export type Cycle = 'MONTH' | 'QUARTER' | 'YEAR';

export interface Span {
  start: string;
  end: string;
}

const MONTHS: Record<Cycle, number> = { MONTH: 1, QUARTER: 3, YEAR: 12 };
const DAY_MS = 86_400_000;

function parse(day: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) throw new RangeError(`Not a calendar day: ${day}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`Not a calendar day: ${day}`);
  }
  return { y, m, d };
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day `months` months after (y, m, anchor); the anchor is ≤ 28, so it always exists. */
function addMonths(y: number, m: number, anchor: number, months: number): string {
  return format(new Date(Date.UTC(y, m - 1 + months, anchor)));
}

/** Days in a span (end exclusive). */
export function daysIn(span: Span): number {
  return Math.round((Date.parse(`${span.end}T00:00:00Z`) - Date.parse(`${span.start}T00:00:00Z`)) / DAY_MS);
}

/**
 * The cycle containing `day`, aligned to the anchor day and to the contract's first cycle (`origin`):
 * quarters and years count from the month the contract started, not from January.
 */
export function cycleContaining(day: string, cycle: Cycle, anchorDay: number, origin: string): Span {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 28) {
    throw new RangeError('The anchor day must be 1–28');
  }
  const target = parse(day);
  const first = parse(origin);
  // The first cycle starts on the anchor day on or before the contract's start.
  let originMonth = first.y * 12 + (first.m - 1);
  if (first.d < anchorDay) originMonth -= 1;
  let targetMonth = target.y * 12 + (target.m - 1);
  if (target.d < anchorDay) targetMonth -= 1;
  const length = MONTHS[cycle];
  const index = Math.floor((targetMonth - originMonth) / length);
  const startMonth = originMonth + index * length;
  const y = Math.floor(startMonth / 12);
  const m = (startMonth % 12) + 1;
  return { start: addMonths(y, m, anchorDay, 0), end: addMonths(y, m, anchorDay, length) };
}

/** The part of `span` inside the contract's active window [startsOn, endsOn); null when empty. */
export function clip(span: Span, startsOn: string, endsOn: string | null): Span | null {
  const start = span.start > startsOn ? span.start : startsOn;
  const end = endsOn !== null && endsOn < span.end ? endsOn : span.end;
  return start < end ? { start, end } : null;
}
