'use client';

import {
  detectNetwork,
  type MobileNetwork,
  normalizeMsisdn,
  type OrderView,
  type PaymentMethod,
  type PaymentStarted,
} from '@studyhub/contracts';
import {
  Alert,
  Button,
  buttonClasses,
  Card,
  formatMoney,
  RadioGroup,
  Select,
  Stepper,
  TextField,
} from '@studyhub/ui';
import NextLink from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { callApi, idempotencyKey, splitProblem } from '../lib/client-api';
import type { CommerceTexts } from '../lib/commerce-texts-type';
import { fill } from '../lib/fill';

const POLL_MS = 3000;
const NO_PROMPT_AFTER_MS = 60_000;
const OPEN = new Set(['INITIATED', 'PENDING']);

/**
 * S-L08 Checkout → S-L09 Payment status → S-L10 Success (F25). The page polls the order while a payment
 * waits for approval; only the server decides that it is paid (BR-09). A card payment returns here from
 * the provider's page, which only triggers a status check (F25 AC 1).
 */
export function Checkout({
  initial,
  texts,
  locale,
  defaultPhone,
}: {
  initial: OrderView;
  texts: CommerceTexts;
  locale: string;
  defaultPhone: string;
}) {
  const t = texts.commerce.checkout;
  const [order, setOrder] = useState(initial);
  const [method, setMethod] = useState<PaymentMethod>(initial.methods[0] ?? 'MOBILE_MONEY');
  const [phone, setPhone] = useState(defaultPhone);
  const [network, setNetwork] = useState<MobileNetwork | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [noPrompt, setNoPrompt] = useState(false);
  const key = useRef<string>(idempotencyKey());
  const refreshed = useRef(false);

  const amount = formatMoney(order.total.amountMinor, order.total.currency, locale);
  const payment = order.payment;
  const waiting = order.status === 'PENDING' && payment !== null && OPEN.has(payment.status) && !showForm;
  const detected = detectNetwork(phone);
  const chosenNetwork = network === '' ? detected : network;

  const reload = useCallback(async () => {
    const result = await callApi<OrderView>('GET', `/api/v1/orders/${order.id}`);
    if (result.ok) setOrder(result.data);
  }, [order.id]);

  // Coming back from the provider's card page: ask the server to check with the provider once.
  useEffect(() => {
    if (refreshed.current || !waiting || payment?.method !== 'CARD') return;
    refreshed.current = true;
    void callApi<OrderView>('POST', `/api/v1/orders/${order.id}/refresh`).then((result) => {
      if (result.ok) setOrder(result.data);
    });
  }, [waiting, payment?.method, order.id]);

  // Poll while the payment waits; after 60 s offer the "Didn't get a prompt?" choices (S-L09).
  useEffect(() => {
    if (!waiting) return undefined;
    const poll = window.setInterval(() => void reload(), POLL_MS);
    const started = payment === null ? Date.now() : new Date(payment.createdAt).getTime();
    const late = window.setTimeout(
      () => setNoPrompt(true),
      Math.max(0, started + NO_PROMPT_AFTER_MS - Date.now()),
    );
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(late);
    };
  }, [waiting, reload, payment]);

  async function pay(chosen: PaymentMethod) {
    setError(null);
    setFieldError(null);
    if (chosen === 'MOBILE_MONEY' && normalizeMsisdn(phone) === null) {
      setFieldError(t.phoneInvalid);
      return;
    }
    setBusy(true);
    const body =
      chosen === 'CARD'
        ? { method: 'CARD' }
        : {
            method: 'MOBILE_MONEY',
            msisdn: phone,
            ...(chosenNetwork !== null && { network: chosenNetwork }),
          };
    const result = await callApi<PaymentStarted>('POST', `/api/v1/orders/${order.id}/payments`, body, {
      'idempotency-key': key.current,
    });
    key.current = idempotencyKey(); // the next attempt is a new request
    if (!result.ok) {
      setBusy(false);
      const { fields, summary } = splitProblem(result.problem, texts.common.networkError);
      if (fields.msisdn !== undefined) setFieldError(fields.msisdn);
      setError(result.problem.code === 'PAYMENT_PROVIDER_UNAVAILABLE' ? t.unavailable : summary);
      return;
    }
    if (result.data.nextAction.type === 'REDIRECT') {
      window.location.assign(result.data.nextAction.url);
      return;
    }
    setShowForm(false);
    setNoPrompt(false);
    setBusy(false);
    await reload();
  }

  async function cancel() {
    setBusy(true);
    const result = await callApi<OrderView>('POST', `/api/v1/orders/${order.id}/cancel`);
    setBusy(false);
    if (result.ok) setOrder(result.data);
  }

  async function simulate(decision: 'approve' | 'decline') {
    if (payment === null) return;
    setBusy(true);
    await callApi('POST', `/api/v1/dev/fake-pay/phone/${payment.id}/${decision}`);
    setBusy(false);
    await reload();
  }

  const item = order.items[0];
  const step = order.status === 'PAID' ? 2 : waiting ? 1 : 0;

  return (
    <div className="flex max-w-reading flex-col gap-6" data-testid="checkout">
      <Stepper
        label={t.stepsLabel}
        steps={[t.steps.review, t.steps.pay, t.steps.confirm]}
        current={step}
        completedLabel={texts.common.done}
      />

      {item !== undefined ? (
        <Card className="flex flex-col gap-1 p-5">
          <h2 className="text-h3">{t.summary}</h2>
          <p className="text-label">{fill(texts.commerce.parts[item.part], { title: item.title })}</p>
          {item.instructorName !== '' ? (
            <p className="text-body-sm text-muted">{fill(t.by, { name: item.instructorName })}</p>
          ) : null}
          <p className="text-body-sm text-muted">
            {item.accessDays === null ? t.accessLifetime : fill(t.accessDays, { days: item.accessDays })}
          </p>
          <p className="mt-2 flex justify-between text-label">
            <span>{t.total}</span>
            <span className="tabular" data-testid="order-total">
              {amount}
            </span>
          </p>
        </Card>
      ) : null}

      <Outcome order={order} texts={texts} />

      {order.status === 'PENDING' && payment !== null && payment.status === 'NEEDS_REVIEW' ? (
        <Alert tone="info" title={t.reviewTitle}>
          {t.reviewMessage}
        </Alert>
      ) : null}

      {waiting && payment !== null ? (
        <Card className="flex flex-col gap-3 p-5" data-testid="payment-waiting">
          <h2 className="text-h3" role="status">
            {payment.method === 'CARD' ? t.confirming : t.approveTitle}
          </h2>
          {payment.method === 'MOBILE_MONEY' ? (
            <p>{fill(t.approveMessage, { amount, phone: payment.maskedMsisdn ?? '' })}</p>
          ) : null}
          <span className="h-[3px] w-full animate-pulse rounded-full bg-accent" aria-hidden="true" />
          <p className="text-body-sm text-muted">{t.canLeave}</p>
          {payment.simulatedPhone ? (
            <div
              className="flex flex-col gap-2 rounded-md border border-dashed border-strong p-3"
              data-testid="simulated-phone"
            >
              <p className="text-label">{t.simulatedPhone}</p>
              <p className="text-caption text-muted">{t.simulatedHint}</p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void simulate('approve')}>
                  {t.approve}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void simulate('decline')}>
                  {t.decline}
                </Button>
              </div>
            </div>
          ) : null}
          {noPrompt && payment.method === 'MOBILE_MONEY' ? (
            <div className="flex flex-col gap-2">
              <p className="text-label">{t.noPrompt}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => void pay('MOBILE_MONEY')}>
                  {t.resend}
                </Button>
                <Button variant="secondary" onClick={() => setShowForm(true)}>
                  {t.otherNumber}
                </Button>
                {order.methods.includes('CARD') ? (
                  <Button variant="secondary" disabled={busy} onClick={() => void pay('CARD')}>
                    {t.payByCard}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {order.allowedActions.includes('pay') &&
      (!waiting || showForm) &&
      payment?.status !== 'NEEDS_REVIEW' ? (
        <Card className="flex flex-col gap-4 p-5">
          {payment !== null && payment.status === 'FAILED' ? (
            <Alert tone="danger" title={t.failedTitle}>
              {payment.failureCode !== null ? texts.commerce.failures[payment.failureCode] : null}
            </Alert>
          ) : null}
          {error !== null ? <Alert tone="danger">{error}</Alert> : null}
          {order.methods.length === 0 ? (
            <Alert tone="warning">{t.noMethods}</Alert>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void pay(method);
              }}
            >
              <RadioGroup
                legend={t.method}
                value={method}
                onValueChange={(value) => setMethod(value as PaymentMethod)}
                options={order.methods.map((m) => ({ value: m, label: texts.commerce.methods[m] }))}
              />
              {method === 'MOBILE_MONEY' ? (
                <>
                  <TextField
                    label={t.phone}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    hint={
                      detected !== null
                        ? `${fill(t.detected, { network: texts.commerce.networks[detected] })}. ${t.phoneHint}`
                        : t.phoneHint
                    }
                    error={fieldError ?? undefined}
                  />
                  {order.networks.length > 1 ? (
                    <Select
                      label={t.network}
                      value={chosenNetwork ?? ''}
                      onValueChange={(value) => setNetwork(value as MobileNetwork)}
                      options={order.networks.map((n) => ({ value: n, label: texts.commerce.networks[n] }))}
                    />
                  ) : null}
                </>
              ) : (
                <p className="text-body-sm text-muted">{t.cardHint}</p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy} data-testid="pay">
                  {busy ? t.paying : fill(t.pay, { amount })}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                  {t.cancel}
                </Button>
              </div>
            </form>
          )}
        </Card>
      ) : null}
    </div>
  );
}

/** The end states: paid (S-L10), refunded, cancelled, expired. */
function Outcome({ order, texts }: { order: OrderView; texts: CommerceTexts }) {
  const t = texts.commerce.checkout;
  const item = order.items[0];
  if (order.status === 'PAID') {
    return (
      <Card className="flex flex-col gap-3 p-5" data-testid="payment-success">
        <h2 className="text-h2" role="status">
          {t.successTitle}
        </h2>
        {order.receiptNumber !== null ? (
          <p>{fill(t.receiptNumber, { number: order.receiptNumber })}</p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {item !== undefined ? (
            <NextLink href={`/learn/courses/${item.courseId}`} className={buttonClasses('primary')}>
              {t.startLearning}
            </NextLink>
          ) : null}
          <NextLink href={`/account/purchases/${order.id}`} className={buttonClasses('secondary')}>
            {t.viewReceipt}
          </NextLink>
        </div>
      </Card>
    );
  }
  const message =
    order.status === 'REFUNDED'
      ? t.refunded
      : order.status === 'CANCELLED'
        ? t.cancelled
        : order.status === 'EXPIRED'
          ? t.expired
          : null;
  if (message === null) return null;
  return (
    <Alert tone="info">
      <span className="flex flex-col gap-2">
        <span>{message}</span>
        {item !== undefined ? (
          <NextLink href={`/c/${item.courseSlug}`} className="text-label">
            {t.backToCourse}
          </NextLink>
        ) : null}
      </span>
    </Alert>
  );
}
