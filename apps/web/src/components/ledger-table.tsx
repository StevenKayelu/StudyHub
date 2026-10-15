import type { LedgerLine } from '@studyhub/contracts';
import { formatMoney } from '@studyhub/ui';
import type { ReactNode } from 'react';

import type { CommerceTexts } from '../lib/commerce-texts-type';

/** Ledger lines with gross, fee, commission and net (F29; S-AD04, S-AD05, S-T11). */
export function LedgerTable({
  entries,
  texts,
  locale,
  select,
}: {
  entries: LedgerLine[];
  texts: CommerceTexts;
  locale: string;
  /** A leading cell per row (the payout run's checkboxes). */
  select?: (entry: LedgerLine) => ReactNode;
}) {
  const e = texts.commerce.earnings;
  const money = (amount: number, currency: string) => formatMoney(amount, currency, locale);
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full text-body-sm">
        <thead className="text-left text-muted">
          <tr>
            {select !== undefined ? <th className="p-2" /> : null}
            <th className="p-2 font-normal">{e.type}</th>
            <th className="p-2 text-right font-normal">{e.gross}</th>
            <th className="p-2 text-right font-normal">{e.fees}</th>
            <th className="p-2 text-right font-normal">{e.commission}</th>
            <th className="p-2 text-right font-normal">{e.net}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map((entry) => (
            <tr key={entry.id}>
              {select !== undefined ? <td className="p-2">{select(entry)}</td> : null}
              <td className="p-2">
                <span className="text-label">{e.types[entry.type]}</span>
                <span className="block text-caption text-muted">
                  {entry.courseTitle} · {e.ledgerStatuses[entry.status]}
                </span>
              </td>
              <td className="tabular p-2 text-right">{money(entry.gross, entry.currency)}</td>
              <td className="tabular p-2 text-right">{money(entry.providerFee, entry.currency)}</td>
              <td className="tabular p-2 text-right">{money(entry.commission, entry.currency)}</td>
              <td className="tabular p-2 text-right text-label">{money(entry.net, entry.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
