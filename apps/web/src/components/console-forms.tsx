'use client';

import type { StaffListResponse } from '@studyhub/contracts';
import { Alert, Button, Card, Dialog, StatusBadge, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { callApi, reloadTo } from '../lib/client-api';
import { type FormTexts, text, useApiForm } from './forms';

const go = reloadTo;

export function ConsoleSignInForm({
  texts,
}: {
  texts: FormTexts & { email: string; password: string; submit: string; submitting: string };
}) {
  const form = useApiForm(texts);
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi<{ next: 'ENROL_TOTP' | 'VERIFY_TOTP' }>('POST', '/api/console/auth/sign-in', {
            email: text(data, 'email'),
            password: text(data, 'password'),
          }),
        );
        if (result !== null) go(result.next === 'ENROL_TOTP' ? '/enrol' : '/verify');
      }}
    >
      {form.feedback}
      <TextField
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        label={texts.email}
        error={form.fieldError('email')}
        required
      />
      <TextField
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        label={texts.password}
        error={form.fieldError('password')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

export function ConsoleVerifyForm({
  texts,
}: {
  texts: FormTexts & { code: string; submit: string; submitting: string };
}) {
  const form = useApiForm(texts);
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi('POST', '/api/console/auth/totp/verify', { code: text(data, 'code').trim() }),
        );
        if (result !== null) go('/');
      }}
    >
      {form.feedback}
      <TextField
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        label={texts.code}
        error={form.fieldError('code')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

export interface EnrolTexts extends FormTexts {
  key: string;
  link: string;
  code: string;
  submit: string;
  submitting: string;
  recoveryTitle: string;
  recoveryBody: string;
  done: string;
}

/** First console sign-in: TOTP enrolment is mandatory (04 §17.5). */
export function ConsoleEnrol({ texts }: { texts: EnrolTexts }) {
  const form = useApiForm(texts);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void callApi<{ secret: string; otpauthUri: string }>('POST', '/api/console/auth/totp/setup').then(
      (result) => {
        if (result.ok) setSetup(result.data);
        else go('/sign-in');
      },
    );
  }, []);

  if (codes !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title={texts.recoveryTitle}>
          {texts.recoveryBody}
        </Alert>
        <ul className="grid grid-cols-2 gap-2 font-mono text-body" data-testid="recovery-codes">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Button variant="primary" onClick={() => go('/')}>
          {texts.done}
        </Button>
      </div>
    );
  }
  if (setup === null) return null;
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi<{ recoveryCodes: string[] }>('POST', '/api/console/auth/totp/enable', {
            code: text(data, 'code').trim(),
          }),
        );
        if (result !== null) setCodes(result.recoveryCodes);
      }}
    >
      <div>
        <p className="text-label">{texts.key}</p>
        <p className="mt-1 font-mono text-body break-all" data-testid="totp-secret">
          {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
        </p>
        <a href={setup.otpauthUri} className="mt-1 inline-block text-body-sm">
          {texts.link}
        </a>
      </div>
      {form.feedback}
      <TextField
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        label={texts.code}
        error={form.fieldError('code')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

export interface StaffTexts extends FormTexts {
  email: string;
  role: string;
  twoStep: string;
  on: string;
  off: string;
  disable: string;
  disabled: string;
  active: string;
  reauthTitle: string;
  reauthBody: string;
  code: string;
  submit: string;
  close: string;
  roleNames: Record<string, string>;
}

/** Staff list (S-C07). Disabling is sensitive: it asks for a fresh TOTP code when needed. */
export function StaffTable({
  staff,
  selfId,
  canDisable,
  texts,
}: {
  staff: StaffListResponse['staff'];
  selfId: string;
  canDisable: boolean;
  texts: StaffTexts;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const reauth = useApiForm(texts);

  async function disable(id: string): Promise<void> {
    const result = await callApi('POST', `/api/console/staff/${id}/disable`);
    if (!result.ok && result.problem.code === 'REAUTH_REQUIRED') {
      setPending(id);
      return;
    }
    setPending(null);
    router.refresh();
  }

  return (
    <Card>
      <ul className="flex flex-col divide-y divide-line">
        {staff.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-label break-all">{member.email}</p>
              <p className="text-body-sm text-muted">
                {texts.roleNames[member.role] ?? member.role} · {texts.twoStep}:{' '}
                {member.totpEnabled ? texts.on : texts.off}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={member.status === 'ACTIVE' ? 'published' : 'failed'}>
                {member.status === 'ACTIVE' ? texts.active : texts.disabled}
              </StatusBadge>
              {canDisable && member.status === 'ACTIVE' && member.id !== selfId ? (
                <Button size="sm" variant="danger" onClick={() => void disable(member.id)}>
                  {texts.disable}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={texts.reauthTitle}
        description={texts.reauthBody}
        closeLabel={texts.close}
      >
        <form
          method="post"
          className="flex flex-col gap-4"
          noValidate
          onSubmit={async (event) => {
            const result = await reauth.submit(event, (data) =>
              callApi('POST', '/api/console/auth/reauth', { code: text(data, 'code').trim() }),
            );
            if (result !== null && pending !== null) await disable(pending);
          }}
        >
          {reauth.feedback}
          <TextField
            id="reauth-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            label={texts.code}
            error={reauth.fieldError('code')}
            required
          />
          <Button type="submit" variant="danger" loading={reauth.busy}>
            {texts.submit}
          </Button>
        </form>
      </Dialog>
    </Card>
  );
}
