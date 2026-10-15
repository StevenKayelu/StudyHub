'use client';

import { Alert, Button, Card, RadioGroup, StatusBadge, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';

interface Method {
  id: string;
  type: 'MOBILE_MONEY' | 'BANK';
  displayHint: string;
  isDefault: boolean;
}

/** S-T12 payout methods: stored encrypted, shown masked; one default (BR-04 with revenue share). */
export function PayoutMethods({ initial, texts }: { initial: Method[]; texts: CommerceTexts }) {
  const t = texts.commerce.payoutMethods;
  const [methods, setMethods] = useState(initial);
  const [type, setType] = useState<'MOBILE_MONEY' | 'BANK'>('MOBILE_MONEY');
  const [values, setValues] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = (key: string) => values[key] ?? '';
  const set = (key: string) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  async function add() {
    const body =
      type === 'MOBILE_MONEY'
        ? { type, msisdn: value('msisdn'), accountName: value('accountName') }
        : {
            type,
            bankName: value('bankName'),
            accountNumber: value('accountNumber'),
            accountName: value('accountName'),
            ...(value('branch').trim() !== '' && { branch: value('branch') }),
          };
    setBusy(true);
    setError(null);
    setFields({});
    const result = await callApi<Method>('POST', '/api/v1/me/payout-methods', body);
    setBusy(false);
    if (result.ok) {
      setMethods((list) => [...list, result.data]);
      setValues({});
      return;
    }
    const split = splitProblem(result.problem, texts.common.networkError);
    setFields(split.fields);
    setError(split.summary);
  }

  async function update(path: string, method: 'POST' | 'DELETE') {
    setBusy(true);
    setError(null);
    const result = await callApi<{ methods: Method[] }>(method, path);
    setBusy(false);
    if (result.ok) setMethods(result.data.methods);
    else setError(splitProblem(result.problem, texts.common.networkError).summary);
  }

  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="payout-methods">
      <h2 className="text-h3">{t.title}</h2>
      <p className="text-body-sm text-muted">{t.hint}</p>
      {methods.length === 0 ? <Alert tone="warning">{t.empty}</Alert> : null}
      <ul className="flex flex-col divide-y divide-line">
        {methods.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="text-label">{m.displayHint}</span>
            {m.isDefault ? <StatusBadge status="published">{t.default}</StatusBadge> : null}
            <span className="flex-1" />
            {!m.isDefault ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void update(`/api/v1/me/payout-methods/${m.id}/default`, 'POST')}
              >
                {t.makeDefault}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void update(`/api/v1/me/payout-methods/${m.id}`, 'DELETE')}
            >
              {t.remove}
            </Button>
          </li>
        ))}
      </ul>
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <h3 className="text-label">{t.add}</h3>
        <RadioGroup
          legend={t.type}
          value={type}
          onValueChange={(v) => setType(v as 'MOBILE_MONEY' | 'BANK')}
          options={[
            { value: 'MOBILE_MONEY', label: t.types.MOBILE_MONEY },
            { value: 'BANK', label: t.types.BANK },
          ]}
        />
        {type === 'MOBILE_MONEY' ? (
          <TextField
            label={t.msisdn}
            type="tel"
            inputMode="tel"
            value={value('msisdn')}
            onChange={set('msisdn')}
            error={fields.msisdn}
          />
        ) : (
          <>
            <TextField
              label={t.bankName}
              value={value('bankName')}
              onChange={set('bankName')}
              error={fields.bankName}
            />
            <TextField
              label={t.accountNumber}
              inputMode="numeric"
              value={value('accountNumber')}
              onChange={set('accountNumber')}
              error={fields.accountNumber}
            />
            <TextField label={t.branch} value={value('branch')} onChange={set('branch')} />
          </>
        )}
        <TextField
          label={t.accountName}
          value={value('accountName')}
          onChange={set('accountName')}
          error={fields.accountName}
        />
        <Button type="submit" variant="secondary" className="self-start" disabled={busy}>
          {t.save}
        </Button>
      </form>
    </Card>
  );
}
