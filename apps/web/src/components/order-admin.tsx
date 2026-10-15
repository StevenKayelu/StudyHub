'use client';

import type { AdminOrderDetail } from '@studyhub/contracts';
import { Alert, Button, Card, RadioGroup, TextField } from '@studyhub/ui';
import { useRef, useState } from 'react';

import { callApi, idempotencyKey, reloadTo, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';
import { fill } from '../lib/fill';

/**
 * S-AD04 / S-AD02 order actions: re-check with the provider, accept an exception (grants access,
 * audited) or refund (through the provider where possible, otherwise recorded manually; F28).
 */
export function OrderActions({
  detail,
  texts,
  amountLabel,
}: {
  detail: AdminOrderDetail;
  texts: CommerceTexts;
  amountLabel: string;
}) {
  const t = texts.commerce.admin.orders;
  const exception = detail.payments.find((p) => p.status === 'NEEDS_REVIEW');
  const recheckable = [...detail.payments]
    .reverse()
    .find((p) =>
      ['INITIATED', 'PENDING', 'CANCELLED', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED'].includes(p.status),
    );
  const guidance = detail.refundGuidance;
  const [mode, setMode] = useState<'PROVIDER' | 'MANUAL'>(
    guidance.refundApi === 'NONE' ? 'MANUAL' : guidance.defaultMode,
  );
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refundKey = useRef(idempotencyKey());

  const fail = (problem: Parameters<typeof splitProblem>[0]) => {
    const split = splitProblem(problem, texts.common.networkError);
    setFields(split.fields);
    setMessage(split.summary === null ? null : { tone: 'danger', text: split.summary });
  };

  async function recheck() {
    if (recheckable === undefined) return;
    setBusy(true);
    const result = await callApi('POST', `/api/v1/admin/payments/${recheckable.id}/recheck`);
    setBusy(false);
    if (result.ok) reloadTo(`/admin/orders/${detail.order.id}`);
    else fail(result.problem);
  }

  async function accept() {
    if (exception === undefined) return;
    setBusy(true);
    const result = await callApi('POST', `/api/v1/admin/payments/${exception.id}/resolve`, {
      decision: 'ACCEPT',
      note,
    });
    setBusy(false);
    if (result.ok) reloadTo(`/admin/orders/${detail.order.id}`);
    else fail(result.problem);
  }

  async function refund() {
    setBusy(true);
    setFields({});
    setMessage(null);
    const result = await callApi<{ status: string; message: string | null }>(
      'POST',
      `/api/v1/admin/orders/${detail.order.id}/refunds`,
      {
        mode,
        reason,
        ...(mode === 'MANUAL' && { reference }),
        // A payment in review (a duplicate or a mismatch) is refunded first, never the order's own payment.
        ...(exception !== undefined && { paymentId: exception.id }),
      },
      { 'idempotency-key': refundKey.current },
    );
    setBusy(false);
    if (result.ok) {
      reloadTo(`/admin/orders/${detail.order.id}`);
      return;
    }
    refundKey.current = idempotencyKey();
    const body = result.problem as unknown as { status?: string; message?: string };
    if (result.status === 409 && body.message !== undefined) {
      setMessage({ tone: 'danger', text: fill(t.refundFailed, { message: body.message }) });
      return;
    }
    fail(result.problem);
  }

  return (
    <div className="flex flex-col gap-4">
      {message !== null ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {detail.allowedActions.includes('recheck') ? (
        <Button variant="secondary" className="self-start" disabled={busy} onClick={() => void recheck()}>
          {t.recheck}
        </Button>
      ) : null}
      {detail.allowedActions.includes('accept') && exception !== undefined ? (
        <Card className="flex flex-col gap-3 p-4">
          <TextField
            label={t.acceptNote}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={fields.note}
          />
          <Button variant="primary" className="self-start" disabled={busy} onClick={() => void accept()}>
            {t.accept}
          </Button>
        </Card>
      ) : null}
      {detail.allowedActions.includes('refund') ? (
        <Card className="flex flex-col gap-3 p-4" data-testid="refund-form">
          <h2 className="text-h3">{t.refundTitle}</h2>
          <p className="text-body-sm text-muted">
            {fill(t.refundGuidance, { days: guidance.windowDays })}
            {guidance.withinWindow ? '' : ` ${t.outsideGuidance}`}
          </p>
          <RadioGroup
            legend={t.refundMode}
            value={mode}
            onValueChange={(value) => setMode(value as 'PROVIDER' | 'MANUAL')}
            options={[
              { value: 'PROVIDER', label: t.refundModes.PROVIDER, disabled: guidance.refundApi === 'NONE' },
              { value: 'MANUAL', label: t.refundModes.MANUAL },
            ]}
          />
          <TextField
            label={t.refundReason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={fields.reason}
          />
          {mode === 'MANUAL' ? (
            <TextField
              label={t.refundReference}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              error={fields.reference}
            />
          ) : null}
          <Button variant="danger" className="self-start" disabled={busy} onClick={() => void refund()}>
            {fill(t.refundConfirm, { amount: amountLabel })}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
