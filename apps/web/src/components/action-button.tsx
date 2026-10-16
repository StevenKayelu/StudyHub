'use client';

import {
  Alert,
  Button,
  type ButtonSize,
  type ButtonVariant,
  Dialog,
  TextArea,
  TextField,
} from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { type ApiResult, callApi, reloadTo, splitProblem } from '../lib/client-api';

export interface ActionTexts {
  close: string;
  cancel: string;
  networkError: string;
  /** Console re-authentication (04 §17.5). */
  reauthTitle: string;
  reauthBody: string;
  code: string;
  verify: string;
}

export interface ActionConfirm {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Adds a required reason, sent as `reason` (S-AD09, F37: every change says why). */
  reasonLabel?: string;
  /** Type-to-confirm (S-AD18): the action stays disabled until this exact text is typed. */
  typeToConfirm?: { label: string; value: string; field: string };
  /** Extra free-text field sent under this key (a note or an external reference). */
  extraField?: { name: string; label: string; required?: boolean };
}

export interface ActionButtonProps {
  label: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  confirm?: ActionConfirm;
  texts: ActionTexts;
  /** After success: refresh the page (default), go somewhere, or open the URL the API returned. */
  then?: 'refresh' | { navigate: string } | 'openUrl' | 'reload';
  /** Shown next to the button after success (e.g. "Approved"). */
  doneLabel?: string;
  testId?: string;
  icon?: ReactNode;
}

/**
 * One API action behind a button, with an optional confirmation dialog, reason, type-to-confirm and
 * (for the console) a TOTP re-authentication prompt when the API asks for one, after which the action
 * is retried once.
 */
export function ActionButton({
  label,
  method,
  path,
  body,
  variant = 'secondary',
  size = 'sm',
  confirm,
  texts,
  then = 'refresh',
  doneLabel,
  testId,
  icon,
}: ActionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [reauth, setReauth] = useState(false);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);

  const payload = (): Record<string, unknown> | undefined => {
    const extra: Record<string, unknown> = {};
    if (confirm?.reasonLabel !== undefined) extra.reason = values.reason?.trim() ?? '';
    if (confirm?.typeToConfirm !== undefined) extra[confirm.typeToConfirm.field] = values.typed ?? '';
    if (confirm?.extraField !== undefined) {
      const value = values.extra?.trim() ?? '';
      if (value !== '' || confirm.extraField.required === true) extra[confirm.extraField.name] = value;
    }
    const merged = { ...body, ...extra };
    return Object.keys(merged).length === 0 ? undefined : merged;
  };

  async function run(): Promise<void> {
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const result: ApiResult<{ url?: string }> = await callApi(method, path, payload());
      if (!result.ok) {
        if (result.problem.code === 'REAUTH_REQUIRED') {
          setReauth(true);
          return;
        }
        const split = splitProblem(result.problem, texts.networkError);
        setFields(split.fields);
        setProblem(split.summary ?? Object.values(split.fields)[0] ?? result.problem.title);
        return;
      }
      setOpen(false);
      setDone(true);
      if (then === 'openUrl' && typeof result.data?.url === 'string') window.location.assign(result.data.url);
      else if (then === 'reload') reloadTo(window.location.pathname);
      else if (typeof then === 'object') router.push(then.navigate);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    const result = await callApi('POST', '/api/console/auth/reauth', { code: code.trim() });
    setBusy(false);
    if (!result.ok) {
      setProblem(splitProblem(result.problem, texts.networkError).summary ?? result.problem.title);
      return;
    }
    setReauth(false);
    setCode('');
    await run();
  }

  const typedOk =
    confirm?.typeToConfirm === undefined || (values.typed ?? '').trim() === confirm.typeToConfirm.value;
  const reasonOk = confirm?.reasonLabel === undefined || (values.reason ?? '').trim().length >= 3;
  const extraOk = confirm?.extraField?.required !== true || (values.extra ?? '').trim() !== '';

  const trigger = (
    <Button
      size={size}
      variant={variant}
      loading={busy && confirm === undefined}
      data-testid={testId}
      onClick={confirm === undefined ? () => void run() : undefined}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <span className="inline-flex flex-col gap-1">
      {confirm === undefined ? (
        trigger
      ) : (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setProblem(null);
          }}
          trigger={trigger}
          title={confirm.title}
          {...(confirm.description !== undefined && { description: confirm.description })}
          closeLabel={texts.close}
          preventClose={busy}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                {texts.cancel}
              </Button>
              <Button
                variant={variant === 'danger' ? 'danger' : 'primary'}
                loading={busy}
                disabled={!typedOk || !reasonOk || !extraOk}
                onClick={() => void run()}
                data-testid={testId === undefined ? undefined : `${testId}-confirm`}
              >
                {confirm.confirmLabel}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {problem !== null ? <Alert tone="danger" role="alert" title={problem} /> : null}
            {confirm.reasonLabel !== undefined ? (
              <TextArea
                id={`${testId ?? 'action'}-reason`}
                label={confirm.reasonLabel}
                rows={3}
                value={values.reason ?? ''}
                error={fields.reason}
                onChange={(event) => setValues((v) => ({ ...v, reason: event.target.value }))}
                required
              />
            ) : null}
            {confirm.extraField !== undefined ? (
              <TextField
                id={`${testId ?? 'action'}-extra`}
                label={confirm.extraField.label}
                value={values.extra ?? ''}
                error={fields[confirm.extraField.name]}
                onChange={(event) => setValues((v) => ({ ...v, extra: event.target.value }))}
                required={confirm.extraField.required === true}
              />
            ) : null}
            {confirm.typeToConfirm !== undefined ? (
              <TextField
                id={`${testId ?? 'action'}-typed`}
                label={confirm.typeToConfirm.label}
                value={values.typed ?? ''}
                error={fields[confirm.typeToConfirm.field]}
                onChange={(event) => setValues((v) => ({ ...v, typed: event.target.value }))}
                autoComplete="off"
                required
              />
            ) : null}
          </div>
        </Dialog>
      )}
      {confirm === undefined && problem !== null ? (
        <span role="alert" className="text-caption text-danger">
          {problem}
        </span>
      ) : null}
      {done && doneLabel !== undefined ? (
        <span role="status" className="text-caption text-muted">
          {doneLabel}
        </span>
      ) : null}
      <Dialog
        open={reauth}
        onOpenChange={(next) => {
          if (!next) setReauth(false);
        }}
        title={texts.reauthTitle}
        description={texts.reauthBody}
        closeLabel={texts.close}
        footer={
          <Button variant="primary" loading={busy} onClick={() => void verify()}>
            {texts.verify}
          </Button>
        }
      >
        <TextField
          id="reauth-code"
          label={texts.code}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </Dialog>
    </span>
  );
}
