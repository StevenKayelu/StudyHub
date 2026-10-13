'use client';

import type { InvitationPreview, SignInResponse } from '@studyhub/contracts';
import { Alert, Button, Checkbox, StatePanel, TextField } from '@studyhub/ui';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { callApi, fragmentToken, reloadTo } from '../lib/client-api';
import { type FormTexts, text, useApiForm } from './forms';

const go = reloadTo;

// --- Sign in (S-A01) and Join (S-A06) ----------------------------------------------------------

export interface SignInTexts extends FormTexts {
  email: string;
  password: string;
  submit: string;
  submitting: string;
  joinTitle: string;
  joinBody: string;
  joinSubmit: string;
  joinCancel: string;
}

export function SignInForm({ texts, returnTo }: { texts: SignInTexts; returnTo: string }) {
  const form = useApiForm(texts);
  const [join, setJoin] = useState<{ ticket: string } | null>(null);
  const joinForm = useApiForm(texts);

  if (join !== null) {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          const done = await joinForm.submit(event, () =>
            callApi('POST', '/api/v1/me/schools/current/join', { ticket: join.ticket }),
          );
          if (done !== null) go(returnTo);
        }}
      >
        {joinForm.feedback}
        <Alert tone="info" title={texts.joinTitle}>
          {texts.joinBody}
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={joinForm.busy} loadingLabel={texts.submitting}>
            {texts.joinSubmit}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setJoin(null)}>
            {texts.joinCancel}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi<SignInResponse>('POST', '/api/v1/auth/sign-in', {
            email: text(data, 'email'),
            password: text(data, 'password'),
          }),
        );
        if (result === null) return;
        if (result.status === 'SIGNED_IN') go(returnTo);
        else setJoin({ ticket: result.ticket });
      }}
    >
      {form.feedback}
      <TextField
        id="email"
        name="email"
        type="email"
        autoComplete="email"
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

// --- Create account (S-A02) --------------------------------------------------------------------

export interface SignUpTexts extends FormTexts {
  name: string;
  email: string;
  password: string;
  passwordHint: string;
  terms: string;
  submit: string;
  submitting: string;
}

export function SignUpForm({ texts }: { texts: SignUpTexts }) {
  const form = useApiForm(texts);
  const router = useRouter();
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const email = text(new FormData(event.currentTarget), 'email');
        const result = await form.submit(event, (data) =>
          callApi('POST', '/api/v1/auth/register', {
            displayName: text(data, 'displayName'),
            email: text(data, 'email'),
            password: text(data, 'password'),
            acceptTerms: data.get('acceptTerms') === 'on',
          }),
        );
        if (result !== null) router.push(`/check-email?email=${encodeURIComponent(email)}`);
      }}
    >
      {form.feedback}
      <TextField
        id="displayName"
        name="displayName"
        autoComplete="name"
        label={texts.name}
        error={form.fieldError('displayName')}
        required
      />
      <TextField
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        label={texts.email}
        error={form.fieldError('email')}
        required
      />
      <TextField
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        label={texts.password}
        hint={texts.passwordHint}
        error={form.fieldError('password')}
        required
      />
      <Checkbox id="acceptTerms" name="acceptTerms" label={texts.terms} />
      {form.fieldError('acceptTerms') !== undefined ? (
        <p className="text-body-sm text-danger">{form.fieldError('acceptTerms')}</p>
      ) : null}
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

// --- Token landing pages: verify email (S-A04) and switch school (BR-68) -----------------------

export interface TokenLandingTexts {
  working: string;
  done: string;
  doneSignedIn?: string;
  failed: string;
  failedBody: string;
  continueLabel: string;
  continueHref: string;
}

/** POSTs the fragment token once on load; signs in when the API returns a session. */
export function TokenLanding({
  endpoint,
  texts,
  nextPath,
}: {
  endpoint: string;
  texts: TokenLandingTexts;
  nextPath: string;
}) {
  const [state, setState] = useState<'working' | 'done' | 'signedIn' | 'failed'>('working');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = fragmentToken();
    // Drop the token from the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    if (token === null) {
      setState('failed');
      return;
    }
    void callApi<{ signedIn?: boolean }>('POST', endpoint, { token }).then((result) => {
      if (!result.ok) return setState('failed');
      if (result.data.signedIn === false) return setState('done');
      setState('signedIn');
      go(nextPath);
    });
  }, [endpoint, nextPath]);

  if (state === 'failed') {
    return (
      <StatePanel
        kind="error"
        headingLevel={1}
        title={texts.failed}
        message={texts.failedBody}
        actions={
          <NextLink href={texts.continueHref} className="text-label">
            {texts.continueLabel}
          </NextLink>
        }
      />
    );
  }
  const title =
    state === 'working'
      ? texts.working
      : state === 'signedIn'
        ? (texts.doneSignedIn ?? texts.done)
        : texts.done;
  return (
    <StatePanel
      kind="coming-soon"
      headingLevel={1}
      title={<span role="status">{title}</span>}
      {...(state === 'done' && {
        actions: (
          <NextLink href={texts.continueHref} className="text-label">
            {texts.continueLabel}
          </NextLink>
        ),
      })}
    />
  );
}

// --- Forgot and reset password (S-A05) ---------------------------------------------------------

export function ForgotPasswordForm({
  texts,
}: {
  texts: FormTexts & { email: string; submit: string; submitting: string; sent: string };
}) {
  const form = useApiForm(texts);
  const [sent, setSent] = useState(false);
  if (sent) return <Alert tone="success" role="status" title={texts.sent} />;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const done = await form.submit(event, (data) =>
          callApi('POST', '/api/v1/auth/password/forgot', { email: text(data, 'email') }),
        );
        if (done !== null) setSent(true);
      }}
    >
      {form.feedback}
      <TextField
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        label={texts.email}
        error={form.fieldError('email')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

export function ResetPasswordForm({
  texts,
}: {
  texts: FormTexts & {
    newPassword: string;
    hint: string;
    submit: string;
    submitting: string;
    done: string;
    signIn: string;
    invalid: string;
  };
}) {
  const form = useApiForm(texts);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setToken(fragmentToken());
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  if (token === undefined) return null;
  if (token === null) return <Alert tone="danger" title={texts.invalid} />;
  if (done) {
    return (
      <Alert
        tone="success"
        role="status"
        title={texts.done}
        action={<NextLink href="/sign-in">{texts.signIn}</NextLink>}
      />
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi('POST', '/api/v1/auth/password/reset', { token, password: text(data, 'password') }),
        );
        if (result !== null) setDone(true);
      }}
    >
      {form.feedback}
      <TextField
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        label={texts.newPassword}
        hint={texts.hint}
        error={form.fieldError('password')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}

// --- Accept an invitation (BR-67) --------------------------------------------------------------

export interface InvitationTexts extends FormTexts {
  title: string;
  body: string;
  existing: string;
  newAccount: string;
  name: string;
  password: string;
  passwordHint: string;
  submit: string;
  submitting: string;
  invalid: string;
  roles: Record<string, string>;
}

export function InvitationAccept({ texts }: { texts: InvitationTexts }) {
  const form = useApiForm(texts);
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitationPreview | 'invalid' | null>(null);
  useEffect(() => {
    const value = fragmentToken();
    setToken(value);
    if (value === null) return setPreview('invalid');
    void callApi<InvitationPreview>('GET', `/api/v1/invitations/preview?token=${value}`).then((result) =>
      setPreview(result.ok ? result.data : 'invalid'),
    );
  }, []);

  if (preview === null) return null;
  if (preview === 'invalid' || token === null) return <Alert tone="danger" title={texts.invalid} />;
  const fill = (template: string) =>
    template
      .replace('{school}', preview.schoolName)
      .replace('{role}', texts.roles[preview.role] ?? preview.role)
      .replace('{email}', preview.email);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const result = await form.submit(event, (data) =>
          callApi('POST', '/api/v1/invitations/accept', {
            token,
            password: text(data, 'password'),
            ...(!preview.accountExists && { displayName: text(data, 'displayName') }),
          }),
        );
        if (result !== null)
          go(preview.role === 'INSTRUCTOR' ? '/studio' : preview.role === 'LEARNER' ? '/learn' : '/admin');
      }}
    >
      <h1 className="text-h1">{fill(texts.title)}</h1>
      <p className="text-body text-muted">{fill(texts.body)}</p>
      <p className="text-body">{preview.accountExists ? texts.existing : texts.newAccount}</p>
      {form.feedback}
      {preview.accountExists ? null : (
        <TextField
          id="displayName"
          name="displayName"
          autoComplete="name"
          label={texts.name}
          error={form.fieldError('displayName')}
          required
        />
      )}
      <TextField
        id="password"
        name="password"
        type="password"
        autoComplete={preview.accountExists ? 'current-password' : 'new-password'}
        label={texts.password}
        {...(!preview.accountExists && { hint: texts.passwordHint })}
        error={form.fieldError('password')}
        required
      />
      <Button type="submit" variant="primary" loading={form.busy} loadingLabel={texts.submitting}>
        {texts.submit}
      </Button>
    </form>
  );
}
