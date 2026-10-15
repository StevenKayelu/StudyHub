'use client';

import type { PaymentAccountView } from '@studyhub/contracts';
import { FAKE_PROFILES } from '@studyhub/contracts';
import { Alert, Button, Card, Select, StatusBadge, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';
import { fill } from '../lib/fill';

const BADGES = { PENDING: 'pending', ACTIVE: 'published', DISABLED: 'draft', FAILED_TEST: 'failed' } as const;

type Credentials = { merchantId: string; apiKey: string; webhookSecret: string; profile: string };
const EMPTY: Credentials = { merchantId: '', apiKey: '', webhookSecret: '', profile: 'FULL' };

/**
 * S-AD15 Payment account (F45, owner). Credentials are write-only: once saved they show only as a masked
 * hint and can be replaced, never viewed. Test connection detects capabilities; Activate follows.
 */
export function PaymentAccountAdmin({
  initial,
  texts,
  formatTime,
}: {
  initial: PaymentAccountView[];
  texts: CommerceTexts;
  formatTime: Record<string, string>;
}) {
  const t = texts.commerce.admin.account;
  const [accounts, setAccounts] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [credentials, setCredentials] = useState<Credentials>(EMPTY);
  const [replacing, setReplacing] = useState<string | null>(null);

  const replace = (account: PaymentAccountView) =>
    setAccounts((list) => list.map((a) => (a.id === account.id ? account : a)));

  async function run(id: string, action: 'test' | 'activate' | 'disable') {
    setBusy(`${id}:${action}`);
    setError(null);
    const result =
      action === 'disable'
        ? await callApi<PaymentAccountView>('DELETE', `/api/v1/admin/payment-accounts/${id}`)
        : await callApi<PaymentAccountView>('POST', `/api/v1/admin/payment-accounts/${id}/${action}`);
    setBusy(null);
    if (!result.ok) {
      setError(splitProblem(result.problem, texts.common.networkError).summary);
      return;
    }
    if (action === 'activate') {
      setAccounts((list) =>
        list.map((a) =>
          a.id === id ? result.data : a.status === 'ACTIVE' ? { ...a, status: 'DISABLED' as const } : a,
        ),
      );
    } else {
      replace(result.data);
    }
  }

  async function save() {
    setBusy('save');
    setError(null);
    setFields({});
    const result =
      replacing === null
        ? await callApi<PaymentAccountView>('POST', '/api/v1/admin/payment-accounts', {
            provider: 'fake',
            label,
            credentials,
          })
        : await callApi<PaymentAccountView>(
            'PUT',
            `/api/v1/admin/payment-accounts/${replacing}/credentials`,
            {
              credentials,
            },
          );
    setBusy(null);
    if (!result.ok) {
      const problem = splitProblem(result.problem, texts.common.networkError);
      setFields(problem.fields);
      setError(problem.summary);
      return;
    }
    if (replacing === null) setAccounts((list) => [result.data, ...list]);
    else replace(result.data);
    setCredentials(EMPTY);
    setLabel('');
    setReplacing(null);
  }

  const field = (key: keyof Credentials) => fields[`credentials.${key}`];

  return (
    <div className="flex flex-col gap-6">
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      {!accounts.some((a) => a.status === 'ACTIVE') ? (
        <Alert tone="warning">{t.disabledWarning}</Alert>
      ) : null}
      {accounts.length === 0 ? <p className="text-muted">{t.empty}</p> : null}
      {accounts.map((account) => (
        <Card key={account.id} className="flex flex-col gap-3 p-5" data-testid="payment-account">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-h3">{account.label}</h2>
            <StatusBadge status={BADGES[account.status]}>{t.statuses[account.status]}</StatusBadge>
          </div>
          <p className="text-body-sm text-muted">{account.maskedHint}</p>
          {account.lastTestedAt !== null ? (
            <p className="text-body-sm">
              {fill(t.lastTest, {
                time: formatTime[account.id] ?? account.lastTestedAt,
                result: account.lastTestResult === 'OK' ? t.testOk : (account.lastTestResult ?? ''),
              })}
            </p>
          ) : null}
          {account.capabilities !== null ? (
            <div>
              <h3 className="text-label">{t.capabilities}</h3>
              <ul className="list-disc ps-5 text-body-sm">
                {account.capabilities.mobileMoney !== null ? (
                  <li>
                    {fill(t.mobileMoney, {
                      networks: account.capabilities.mobileMoney.networks
                        .map((n) => texts.commerce.networks[n])
                        .join(', '),
                    })}
                  </li>
                ) : null}
                {account.capabilities.card ? <li>{t.card}</li> : null}
                <li>{fill(t.refunds, { kind: t.refundKinds[account.capabilities.refundApi] })}</li>
              </ul>
            </div>
          ) : null}
          <p className="text-caption text-muted break-all">
            {t.webhook}: {account.webhookPath}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy !== null} onClick={() => void run(account.id, 'test')}>
              {busy === `${account.id}:test` ? t.testing : t.test}
            </Button>
            {account.status !== 'ACTIVE' ? (
              <Button
                variant="primary"
                disabled={busy !== null || account.lastTestResult !== 'OK'}
                onClick={() => void run(account.id, 'activate')}
              >
                {t.activate}
              </Button>
            ) : null}
            {account.status !== 'DISABLED' ? (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void run(account.id, 'disable')}
              >
                {t.disable}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setReplacing(account.id)}>
              {t.replace}
            </Button>
          </div>
        </Card>
      ))}

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-h3">{replacing === null ? t.connect : t.replace}</h2>
        <p className="text-body-sm text-muted">{replacing === null ? t.fakeNote : t.replaceHint}</p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {replacing === null ? (
            <TextField
              label={t.label}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              error={fields.label}
            />
          ) : null}
          <TextField
            label={t.merchantId}
            value={credentials.merchantId}
            autoComplete="off"
            onChange={(e) => setCredentials({ ...credentials, merchantId: e.target.value })}
            error={field('merchantId')}
          />
          <TextField
            label={t.apiKey}
            type="password"
            autoComplete="off"
            value={credentials.apiKey}
            onChange={(e) => setCredentials({ ...credentials, apiKey: e.target.value })}
            error={field('apiKey')}
          />
          <TextField
            label={t.webhookSecret}
            type="password"
            autoComplete="off"
            value={credentials.webhookSecret}
            onChange={(e) => setCredentials({ ...credentials, webhookSecret: e.target.value })}
            error={field('webhookSecret')}
          />
          <Select
            label={t.profile}
            value={credentials.profile}
            onValueChange={(value) => setCredentials({ ...credentials, profile: value })}
            options={FAKE_PROFILES.map((p) => ({ value: p, label: p }))}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy !== null}>
              {t.connect}
            </Button>
            {replacing !== null ? (
              <Button type="button" variant="ghost" onClick={() => setReplacing(null)}>
                {texts.common.cancel}
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
