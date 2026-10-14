'use client';

import { Alert, Button, Card } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

const input = 'h-11 rounded-md border border-strong bg-surface px-3 font-normal';

/** F14 ADMIN_GRANT: give a member of this school access to the course, with a reason (audited). */
export function GrantAccess({ courseId, texts }: { courseId: string; texts: StudioTexts }) {
  const e = texts.admin.enrollments;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-h3">{e.grantTitle}</h2>
      <p className="text-body-sm text-muted">{e.grantHint}</p>
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <form
        className="flex flex-col gap-3 md:flex-row md:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError(null);
          const result = await callApi('POST', `/api/v1/admin/courses/${courseId}/enrollments`, {
            email: String(data.get('email') ?? ''),
            reason: String(data.get('reason') ?? ''),
          });
          setBusy(false);
          if (result.ok) {
            form.reset();
            router.refresh();
            return;
          }
          const split = splitProblem(result.problem, texts.common.networkError);
          setError(split.summary ?? Object.values(split.fields)[0] ?? '');
        }}
      >
        <label htmlFor={`${id}-email`} className="flex flex-1 flex-col gap-1 text-label">
          {e.email}
          <input id={`${id}-email`} name="email" type="email" required autoComplete="off" className={input} />
        </label>
        <label htmlFor={`${id}-reason`} className="flex flex-1 flex-col gap-1 text-label">
          {e.reason}
          <input
            id={`${id}-reason`}
            name="reason"
            required
            minLength={3}
            maxLength={2000}
            className={input}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {e.grant}
        </Button>
      </form>
    </Card>
  );
}

/** Revoke with a reason; the learner loses access on their next request (F14 AC 2). */
export function RevokeAccess({ enrollmentId, texts }: { enrollmentId: string; texts: StudioTexts }) {
  const e = texts.admin.enrollments;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {e.revoke}
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await callApi('POST', `/api/v1/admin/enrollments/${enrollmentId}/revoke`, { reason });
        setBusy(false);
        if (result.ok) {
          router.refresh();
          return;
        }
        setError(splitProblem(result.problem, texts.common.networkError).summary);
      }}
    >
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <label htmlFor={id} className="flex flex-1 flex-col gap-1 text-label">
        {e.revokeReason}
        <input
          id={id}
          value={reason}
          required
          minLength={3}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
          className={input}
        />
      </label>
      <Button type="submit" size="sm" variant="primary" disabled={busy || reason.trim().length < 3}>
        {e.confirmRevoke}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {texts.common.cancel}
      </Button>
    </form>
  );
}
