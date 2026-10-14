'use client';

import type { StudioCourse } from '@studyhub/contracts';
import { Alert, Button, RadioGroup, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';
import { text, useApiForm } from './forms';

/** Kwacha with up to two decimals to ngwee ("250" → 25000); null when not a valid amount. */
function toMinor(value: string): number | null {
  const match = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

/** S-T05 Pricing and access. Paid courses can be prepared; selling them arrives with payments (M8). */
export function PricingForm({
  course,
  editable,
  texts,
}: {
  course: StudioCourse;
  editable: boolean;
  texts: StudioTexts;
}) {
  const router = useRouter();
  const p = texts.studio.pricing;
  const form = useApiForm(texts.common);
  const [paid, setPaid] = useState(course.priceMinor > 0);
  const [limited, setLimited] = useState(course.accessDays !== null);
  const [saved, setSaved] = useState(false);
  const [priceError, setPriceError] = useState<string | undefined>(undefined);

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
        const result = await form.submit(event, () =>
          callApi<StudioCourse>('PATCH', `/api/v1/studio/courses/${course.id}`, {
            version: course.version,
            priceMinor,
            accessDays: limited && Number.isInteger(days) && days > 0 ? days : null,
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
              defaultValue={course.priceMinor > 0 ? (course.priceMinor / 100).toFixed(2) : ''}
              error={priceError ?? form.fieldError('priceMinor')}
            />
            <Alert tone="info" title={p.paidSoon} />
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
