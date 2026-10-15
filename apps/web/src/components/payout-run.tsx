'use client';

import type { LedgerLine } from '@studyhub/contracts';
import { Alert, Button, Card, Checkbox, formatMoney, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';
import { fill } from '../lib/fill';
import { LedgerTable } from './ledger-table';

/**
 * S-AD05 payout run (W3): select available entries → total → external reference and date → record.
 * Negative entries (refunds after an earlier payout) are always included and can't be unticked (AC 7).
 */
export function PayoutRun({
  membershipId,
  entries,
  texts,
  locale,
  today,
}: {
  membershipId: string;
  entries: LedgerLine[];
  texts: CommerceTexts;
  locale: string;
  today: string;
}) {
  const t = texts.commerce.admin.payouts;
  const now = Date.now();
  const available = entries.filter(
    (e) => e.status === 'AVAILABLE' || (e.status === 'PENDING' && new Date(e.availableAt).getTime() <= now),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set(available.map((e) => e.id)));
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currency = available[0]?.currency ?? 'ZMW';
  const total = available.filter((e) => selected.has(e.id)).reduce((sum, e) => sum + e.net, 0);
  const amount = formatMoney(total, currency, locale);

  if (available.length === 0) return null;

  async function record() {
    setBusy(true);
    setError(null);
    setFields({});
    const result = await callApi('POST', '/api/v1/admin/payouts', {
      membershipId,
      entryIds: [...selected],
      externalReference: reference,
      paidAt,
      ...(note.trim() !== '' && { note }),
    });
    setBusy(false);
    if (result.ok) {
      reloadTo(`/admin/payouts/${membershipId}?recorded=1`);
      return;
    }
    const split = splitProblem(result.problem, texts.common.networkError);
    setFields(split.fields);
    setError(split.fields.entryIds ?? split.summary);
  }

  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="payout-run">
      <h2 className="text-h3">{t.select}</h2>
      <p className="text-body-sm text-muted">{t.negativeIncluded}</p>
      <LedgerTable
        entries={available}
        texts={texts}
        locale={locale}
        select={(entry) => (
          <Checkbox
            label={<span className="sr-only">{entry.courseTitle}</span>}
            checked={selected.has(entry.id)}
            disabled={entry.net < 0}
            onCheckedChange={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(entry.id);
                else next.delete(entry.id);
                return next;
              })
            }
          />
        )}
      />
      <p className="tabular text-label" role="status">
        {fill(t.selected, { amount })}
      </p>
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t.reference}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        error={fields.externalReference}
      />
      <TextField
        label={t.paidAt}
        type="date"
        value={paidAt}
        onChange={(e) => setPaidAt(e.target.value)}
        error={fields.paidAt}
      />
      <TextField label={t.note} value={note} onChange={(e) => setNote(e.target.value)} />
      <Button
        variant="primary"
        className="self-start"
        disabled={busy || total <= 0}
        onClick={() => void record()}
      >
        {fill(t.record, { amount })}
      </Button>
    </Card>
  );
}
