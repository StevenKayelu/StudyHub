'use client';

import type { MySchoolsResponse } from '@studyhub/contracts';
import { Alert, Button, Card, StatusBadge, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { callApi, reloadTo } from '../lib/client-api';
import { type FormTexts, text, useApiForm } from './forms';

type School = MySchoolsResponse['schools'][number];

/** School switcher (06 §10.2, BR-68): only for people with more than one active membership. */
export function SchoolSwitcher({
  schools,
  texts,
}: {
  schools: School[];
  texts: { title: string; current: string; switchTo: string; failed: string; roles: Record<string, string> };
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (schools.length < 2) return null;
  return (
    <Card>
      <h2 className="text-h3">{texts.title}</h2>
      {failed ? <Alert tone="danger" role="alert" title={texts.failed} /> : null}
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {schools.map((school) => (
          <li key={school.tenantId} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <p className="text-label">{school.name}</p>
              <p className="text-body-sm text-muted">
                {school.roles.map((role) => texts.roles[role] ?? role).join(', ')}
              </p>
            </div>
            {school.current ? (
              <StatusBadge status="published">{texts.current}</StatusBadge>
            ) : (
              <Button
                size="sm"
                loading={busy === school.tenantId}
                onClick={async () => {
                  setBusy(school.tenantId);
                  setFailed(false);
                  const result = await callApi<{ url: string }>(
                    'POST',
                    `/api/v1/me/schools/${school.tenantId}/handoff`,
                  );
                  if (result.ok) reloadTo(result.data.url);
                  else {
                    setFailed(true);
                    setBusy(null);
                  }
                }}
              >
                {texts.switchTo.replace('{school}', school.name)}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export interface SessionRow {
  id: string;
  current: boolean;
  lastSeen: string;
  device: string;
}

/** Signed-in devices in this school, with "sign out everywhere" (BR-69). */
export function SessionsPanel({
  sessions,
  texts,
}: {
  sessions: SessionRow[];
  texts: {
    title: string;
    thisDevice: string;
    endSession: string;
    everywhere: string;
    everywhereHint: string;
  };
}) {
  const [rows, setRows] = useState(sessions);
  return (
    <Card>
      <h2 className="text-h3">{texts.title}</h2>
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {rows.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <p className="text-body">{session.device}</p>
              <p className="text-body-sm text-muted">{session.lastSeen}</p>
            </div>
            {session.current ? (
              <StatusBadge status="published">{texts.thisDevice}</StatusBadge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const result = await callApi('DELETE', `/api/v1/me/sessions/${session.id}`);
                  if (result.ok) setRows((current) => current.filter((row) => row.id !== session.id));
                }}
              >
                {texts.endSession}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-col items-start gap-1">
        <Button
          variant="danger"
          size="sm"
          onClick={async () => {
            await callApi('DELETE', '/api/v1/me/sessions');
            reloadTo('/sign-in');
          }}
        >
          {texts.everywhere}
        </Button>
        <p className="text-body-sm text-muted">{texts.everywhereHint}</p>
      </div>
    </Card>
  );
}

export function ChangePasswordForm({
  texts,
}: {
  texts: FormTexts & {
    title: string;
    current: string;
    next: string;
    hint: string;
    submit: string;
    submitting: string;
    done: string;
  };
}) {
  const form = useApiForm(texts);
  const [done, setDone] = useState(false);
  return (
    <Card>
      <h2 className="text-h3">{texts.title}</h2>
      <form
        method="post"
        className="mt-3 flex max-w-md flex-col gap-4"
        noValidate
        onSubmit={async (event) => {
          const target = event.currentTarget;
          const result = await form.submit(event, (data) =>
            callApi('POST', '/api/v1/me/password', {
              currentPassword: text(data, 'currentPassword'),
              newPassword: text(data, 'newPassword'),
            }),
          );
          if (result !== null) {
            setDone(true);
            target.reset();
          }
        }}
      >
        {done ? <Alert tone="success" role="status" title={texts.done} /> : null}
        {form.feedback}
        <TextField
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          label={texts.current}
          error={form.fieldError('currentPassword')}
          required
        />
        <TextField
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          label={texts.next}
          hint={texts.hint}
          error={form.fieldError('newPassword')}
          required
        />
        <Button type="submit" loading={form.busy} loadingLabel={texts.submitting}>
          {texts.submit}
        </Button>
      </form>
    </Card>
  );
}

export function ResendVerification({ label, sentLabel }: { label: string; sentLabel: string }) {
  const [sent, setSent] = useState(false);
  if (sent) return <p className="text-body-sm text-success">{sentLabel}</p>;
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        const result = await callApi('POST', '/api/v1/auth/verify-email/resend');
        if (result.ok) setSent(true);
      }}
    >
      {label}
    </Button>
  );
}
