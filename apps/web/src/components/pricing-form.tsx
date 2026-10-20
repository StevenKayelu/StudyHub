'use client';

import type { StudioCourse } from '@studyhub/contracts';
import { Alert, Button, RadioGroup, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';
import { text, useApiForm } from './forms';

/** Kwacha with up to two decimals to ngwee ("250" → 25000); null when not a valid amount. */
function toMinor(value: string): number | null {
  const match = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

/** Half-up to the ngwee, as the server computes commission (BR-14). */
const commissionOf = (minor: number, bps: number) => Math.floor((minor * bps * 2 + 10_000) / 20_000);

/**
 * S-T05 / S-T07 Pricing and access. With instructor revenue share the form previews the split:
 * "Learner pays K250.00 · Commission K50.00 · You earn ≈ K200.00" (the provider fee varies).
 */
export function PricingForm({
  course,
  editable,
  texts,
  commissionBps,
}: {
  course: StudioCourse;
  editable: boolean;
  texts: StudioTexts;
  /** The school's instructor commission, or null without revenue share. */
  commissionBps: number | null;
}) {
  const router = useRouter();
  const p = texts.studio.pricing;
  const form = useApiForm(texts.common);
  const [paid, setPaid] = useState(course.priceMinor > 0);
  const [limited, setLimited] = useState(course.accessDays !== null);
  const [saved, setSaved] = useState(false);
  const [priceError, setPriceError] = useState<string | undefined>(undefined);
  const [priceText, setPriceText] = useState(
    course.priceMinor > 0 ? (course.priceMinor / 100).toFixed(2) : '',
  );
  const previewMinor = toMinor(priceText);
  const kwacha = (minor: number) => `K${(minor / 100).toFixed(2)}`;
  // Deposit plans (docs/design/payment-plans.md), within the school's rules.
  const rules = course.depositRules;
  const [withDeposit, setWithDeposit] = useState(course.depositPlan !== null);
  const [depositText, setDepositText] = useState(
    course.depositPlan === null ? '' : (course.depositPlan.depositMinor / 100).toFixed(2),
  );
  const [lessonPctText, setLessonPctText] = useState(String(course.depositPlan?.lessonPct ?? 30));
  const [daysText, setDaysText] = useState(
    String(course.depositPlan?.balanceDueDays ?? Math.min(30, rules.maxBalanceDays)),
  );
  const [depositError, setDepositError] = useState<string | undefined>(undefined);
  const depositMinor = toMinor(depositText);
  const lessonPct = Number(lessonPctText);
  const balanceDays = Number(daysText);
  const planValid =
    depositMinor !== null &&
    depositMinor > 0 &&
    Number.isInteger(lessonPct) &&
    lessonPct >= 1 &&
    lessonPct <= 99 &&
    Number.isInteger(balanceDays) &&
    balanceDays >= 1;

  return (
    <form
      noValidate
      className="flex max-w-reading flex-col gap-5"
      onSubmit={async (event) => {
        setSaved(false);
        setPriceError(undefined);
        const data = new FormData(event.currentTarget);
        const priceMinor = paid ? toMinor(text(data, 'price')) : 0;
        if (priceMinor === null || (paid && priceMinor === 0)) {
          event.preventDefault();
          setPriceError(p.price);
          return;
        }
        const days = Number(text(data, 'accessDays'));
        const offerDeposit = paid && rules.enabled && withDeposit;
        if (offerDeposit && !planValid) {
          event.preventDefault();
          setDepositError(p.depositInvalid);
          return;
        }
        setDepositError(undefined);
        // Free courses can't keep a plan; with plans switched off a saved plan is kept, not offered.
        const depositPlan = offerDeposit
          ? { depositMinor: depositMinor!, lessonPct, balanceDueDays: balanceDays }
          : (!paid || rules.enabled) && course.depositPlan !== null
            ? null
            : undefined;
        const result = await form.submit(event, () =>
          callApi<StudioCourse>('PATCH', `/api/v1/studio/courses/${course.id}`, {
            version: course.version,
            priceMinor,
            accessDays: limited && Number.isInteger(days) && days > 0 ? days : null,
            ...(depositPlan !== undefined && { depositPlan }),
          }),
        );
        if (result !== null) {
          setSaved(true);
          router.refresh();
        }
      }}
    >
      {form.feedback}
      {saved ? <Alert tone="success" role="status" title={texts.common.saved} /> : null}
      <fieldset disabled={!editable || form.busy} className="flex flex-col gap-5">
        <RadioGroup
          legend={p.title}
          name="model"
          value={paid ? 'paid' : 'free'}
          onValueChange={(value) => setPaid(value === 'paid')}
          options={[
            { value: 'free', label: p.free },
            { value: 'paid', label: p.paid },
          ]}
        />
        {paid ? (
          <>
            <TextField
              id="priceMinor"
              name="price"
              label={p.price}
              inputMode="decimal"
              value={priceText}
              onChange={(event) => setPriceText(event.target.value)}
              error={priceError ?? form.fieldError('priceMinor')}
            />
            {commissionBps !== null && previewMinor !== null && previewMinor > 0 ? (
              <p className="text-body-sm" data-testid="earnings-preview">
                {fill(p.preview, {
                  price: kwacha(previewMinor),
                  commission: kwacha(commissionOf(previewMinor, commissionBps)),
                  net: kwacha(previewMinor - commissionOf(previewMinor, commissionBps)),
                })}
                <span className="block text-caption text-muted">{p.previewFee}</span>
              </p>
            ) : null}
            <Alert tone="info" title={p.paidNote} />
            {!rules.enabled && course.depositPlan !== null ? (
              <Alert tone="warning" title={p.depositOff} />
            ) : null}
            {rules.enabled ? (
              <>
                <RadioGroup
                  legend={p.paymentOptions}
                  name="paymentOptions"
                  value={withDeposit ? 'deposit' : 'full'}
                  onValueChange={(value) => setWithDeposit(value === 'deposit')}
                  options={[
                    { value: 'full', label: p.fullOnly },
                    { value: 'deposit', label: p.withDeposit },
                  ]}
                />
                {withDeposit ? (
                  <div className="flex flex-col gap-4" data-testid="deposit-plan">
                    <TextField
                      id="depositPlan.depositMinor"
                      name="deposit"
                      label={p.deposit}
                      inputMode="decimal"
                      value={depositText}
                      onChange={(event) => setDepositText(event.target.value)}
                      hint={
                        previewMinor !== null && previewMinor > 0
                          ? fill(p.depositHint, {
                              percent: rules.minDepositPct,
                              amount: kwacha(Math.ceil((previewMinor * rules.minDepositPct) / 100)),
                            })
                          : undefined
                      }
                      error={
                        depositError ??
                        form.fieldError('depositPlan.depositMinor') ??
                        form.fieldError('depositPlan')
                      }
                    />
                    <TextField
                      id="depositPlan.lessonPct"
                      name="lessonPct"
                      label={p.lessonPct}
                      inputMode="numeric"
                      value={lessonPctText}
                      onChange={(event) => setLessonPctText(event.target.value)}
                      hint={p.lessonPctHint}
                      error={form.fieldError('depositPlan.lessonPct')}
                    />
                    <TextField
                      id="depositPlan.balanceDueDays"
                      name="balanceDays"
                      label={p.balanceDays}
                      inputMode="numeric"
                      value={daysText}
                      onChange={(event) => setDaysText(event.target.value)}
                      hint={fill(p.balanceDaysHint, { days: rules.maxBalanceDays })}
                      error={form.fieldError('depositPlan.balanceDueDays')}
                    />
                    {planValid && previewMinor !== null && depositMinor! < previewMinor ? (
                      <p className="text-body-sm" data-testid="deposit-preview">
                        {fill(p.depositPreview, {
                          deposit: kwacha(depositMinor!),
                          balance: kwacha(previewMinor - depositMinor!),
                          days: balanceDays,
                          percent: lessonPct,
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        <RadioGroup
          legend={p.access}
          name="access"
          value={limited ? 'days' : 'lifetime'}
          onValueChange={(value) => setLimited(value === 'days')}
          options={[
            { value: 'lifetime', label: p.lifetime },
            { value: 'days', label: p.days },
          ]}
        />
        {limited ? (
          <TextField
            id="accessDays"
            name="accessDays"
            label={p.accessDays}
            inputMode="numeric"
            defaultValue={course.accessDays?.toString() ?? '365'}
            error={form.fieldError('accessDays')}
          />
        ) : null}
        <div>
          <Button type="submit" variant="primary">
            {texts.common.save}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
