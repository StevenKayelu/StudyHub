'use client';

import { Alert, Button, TextArea, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi } from '../lib/client-api';
import { fill } from '../lib/fill';
import { type FormTexts, text, useApiForm } from './forms';

export interface DomainTexts extends FormTexts {
  slug: string;
  reason: string;
  check: string;
  available: string;
  problems: Record<string, string>;
  submit: string;
  sent: string;
  suffix: string;
}

/** S-AD19: request a different subdomain, with a live availability and reserved-word check (BR-50). */
export function DomainRequestForm({ texts }: { texts: DomainTexts }) {
  const router = useRouter();
  const form = useApiForm(texts);
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function check(): Promise<void> {
    const result = await callApi<{ slug: string; available: boolean; problem: string | null }>(
      'GET',
      `/api/v1/admin/domains/availability?slug=${encodeURIComponent(slug.trim().toLowerCase())}`,
    );
    if (!result.ok) {
      setStatus(result.problem.title);
      return;
    }
    setStatus(
      result.data.available
        ? fill(texts.available, { slug: `${result.data.slug}.${texts.suffix}` })
        : (texts.problems[result.data.problem ?? 'FORMAT'] ?? ''),
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const done = await form.submit(event, (data) =>
          callApi('POST', '/api/v1/admin/domains/change-requests', {
            requestedSlug: text(data, 'requestedSlug').trim().toLowerCase(),
            reason: text(data, 'reason').trim(),
          }),
        );
        if (done !== null) {
          setSent(true);
          router.refresh();
        }
      }}
    >
      {form.feedback}
      {sent ? <Alert tone="success" role="status" title={texts.sent} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <TextField
            id="requestedSlug"
            name="requestedSlug"
            label={texts.slug}
            hint={`.${texts.suffix}`}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setStatus(null);
            }}
            error={form.fieldError('requestedSlug')}
            autoComplete="off"
            required
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void check()}
          disabled={slug.trim().length < 3}
        >
          {texts.check}
        </Button>
      </div>
      {status !== null ? (
        <p role="status" className="text-body-sm" data-testid="slug-status">
          {status}
        </p>
      ) : null}
      <TextArea
        id="reason"
        name="reason"
        label={texts.reason}
        rows={3}
        error={form.fieldError('reason')}
        required
      />
      <div>
        <Button type="submit" variant="primary" loading={form.busy}>
          {texts.submit}
        </Button>
      </div>
    </form>
  );
}
