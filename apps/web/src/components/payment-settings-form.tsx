'use client';

import type { AdminSettings } from '@studyhub/contracts';
import { Alert, Button, Card, Checkbox, RadioGroup, Select, TextArea, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';

const METHODS = ['MOBILE_MONEY', 'CARD'] as const;

/**
 * S-AD09 Settings → Payments (BR-62). Methods appear only as the active account reported them;
 * unsupported ones are shown disabled with the reason. Every change asks for a reason.
 */
export function PaymentSettingsForm({ initial, texts }: { initial: AdminSettings; texts: CommerceTexts }) {
  const t = texts.commerce.admin.settings;
  const c = initial.commerce;
  const supported = initial.supported;
  const [methods, setMethods] = useState<string[]>(c.enabledPaymentMethods);
  const [minPrice, setMinPrice] = useState((c.minPaidPriceMinor / 100).toFixed(2));
  const [expiry, setExpiry] = useState(String(c.orderExpiryMinutes));
  const [windowDays, setWindowDays] = useState(String(c.refundWindowDays));
  const [refundMode, setRefundMode] = useState<string>(c.refundMode);
  const [commission, setCommission] = useState(String(c.instructorCommissionBps / 100));
  const [schedule, setSchedule] = useState<string>(c.payoutSchedule);
  const [deposits, setDeposits] = useState(c.depositPlans.enabled);
  const [minDepositPct, setMinDepositPct] = useState(String(c.depositPlans.minDepositPct));
  const [maxBalanceDays, setMaxBalanceDays] = useState(String(c.depositPlans.maxBalanceDays));
  const [seller, setSeller] = useState({
    legalName: c.receiptSeller.legalName ?? '',
    address: c.receiptSeller.address ?? '',
    taxId: c.receiptSeller.taxId ?? '',
  });
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (supported === null) return <Alert tone="info">{t.noAccount}</Alert>;

  async function save() {
    setBusy(true);
    setFields({});
    setMessage(null);
    const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
    const result = await callApi<AdminSettings>('PATCH', '/api/v1/admin/settings', {
      enabledPaymentMethods: methods,
      minPaidPriceMinor: Math.round(Number(minPrice) * 100),
      orderExpiryMinutes: Number(expiry),
      refundWindowDays: Number(windowDays),
      refundMode,
      ...(initial.revenueShare && {
        instructorCommissionBps: Math.round(Number(commission) * 100),
        payoutSchedule: schedule,
      }),
      depositPlans: {
        enabled: deposits,
        minDepositPct: Number(minDepositPct),
        maxBalanceDays: Number(maxBalanceDays),
      },
      receiptSeller: {
        legalName: orNull(seller.legalName),
        address: orNull(seller.address),
        taxId: orNull(seller.taxId),
      },
      reason,
    });
    setBusy(false);
    if (!result.ok) {
      const problem = splitProblem(result.problem, texts.common.networkError);
      setFields(problem.fields);
      setMessage(problem.summary === null ? null : { tone: 'danger', text: problem.summary });
      return;
    }
    setReason('');
    setMessage({ tone: 'success', text: t.saved });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <h2 className="text-h2">{t.payments}</h2>
      <p className="text-body-sm text-muted">{t.paymentsHint}</p>
      {message !== null ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label">{t.methods}</legend>
          {METHODS.map((method) => {
            const ok = supported.methods.includes(method);
            return (
              <Checkbox
                key={method}
                label={texts.commerce.methods[method]}
                hint={ok ? undefined : t.unsupported}
                checked={methods.includes(method)}
                disabled={!ok}
                onCheckedChange={(checked) =>
                  setMethods((list) => (checked ? [...list, method] : list.filter((m) => m !== method)))
                }
              />
            );
          })}
          {fields.enabledPaymentMethods !== undefined ? (
            <p className="text-body-sm text-danger">{fields.enabledPaymentMethods}</p>
          ) : null}
        </fieldset>
        <TextField
          label={t.minPrice}
          inputMode="decimal"
          value={minPrice}
          onChange={(e) => setMinPrice(e.target.value)}
          error={fields.minPaidPriceMinor}
        />
        <TextField
          label={t.orderExpiry}
          inputMode="numeric"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          error={fields.orderExpiryMinutes}
        />
        <TextField
          label={t.refundWindow}
          hint={t.refundWindowHint}
          inputMode="numeric"
          value={windowDays}
          onChange={(e) => setWindowDays(e.target.value)}
          error={fields.refundWindowDays}
        />
        <RadioGroup
          legend={t.refundMode}
          value={refundMode}
          onValueChange={setRefundMode}
          options={[
            {
              value: 'PROVIDER_API',
              label: t.refundModes.PROVIDER_API,
              disabled: supported.refundApi === 'NONE',
            },
            { value: 'MANUAL', label: t.refundModes.MANUAL },
          ]}
        />
        {fields.refundMode !== undefined ? (
          <p className="text-body-sm text-danger">{fields.refundMode}</p>
        ) : null}
        {initial.revenueShare ? (
          <>
            <TextField
              label={t.commission}
              hint={t.commissionHint}
              inputMode="decimal"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              error={fields.instructorCommissionBps}
            />
            <Select
              label={t.payoutSchedule}
              value={schedule}
              onValueChange={setSchedule}
              options={(['WEEKLY', 'MONTHLY', 'ON_REQUEST'] as const).map((s) => ({
                value: s,
                label: texts.commerce.earnings.schedules[s],
              }))}
            />
          </>
        ) : null}
        <fieldset className="flex flex-col gap-3" data-testid="deposit-rules">
          <legend className="mb-1 text-label">{t.depositPlans}</legend>
          <Checkbox
            label={t.depositPlansEnabled}
            hint={t.depositPlansHint}
            checked={deposits}
            onCheckedChange={(checked) => setDeposits(checked === true)}
          />
          {deposits ? (
            <>
              <TextField
                label={t.minDepositPct}
                inputMode="numeric"
                value={minDepositPct}
                onChange={(e) => setMinDepositPct(e.target.value)}
                error={fields['depositPlans.minDepositPct'] ?? fields.depositPlans}
              />
              <TextField
                label={t.maxBalanceDays}
                inputMode="numeric"
                value={maxBalanceDays}
                onChange={(e) => setMaxBalanceDays(e.target.value)}
                error={fields['depositPlans.maxBalanceDays']}
              />
            </>
          ) : null}
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-label">{t.seller}</legend>
          <TextField
            label={t.legalName}
            value={seller.legalName}
            onChange={(e) => setSeller({ ...seller, legalName: e.target.value })}
          />
          <TextArea
            label={t.address}
            value={seller.address}
            onChange={(e) => setSeller({ ...seller, address: e.target.value })}
          />
          <TextField
            label={t.taxId}
            value={seller.taxId}
            onChange={(e) => setSeller({ ...seller, taxId: e.target.value })}
          />
        </fieldset>
        <TextField
          label={t.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={fields.reason}
          required
        />
        <Button type="submit" variant="primary" className="self-start" disabled={busy}>
          {t.save}
        </Button>
      </form>
    </Card>
  );
}
