'use client';

import { Alert, Button, Checkbox, Dialog, Select, TextArea, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { type ApiResult, callApi, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import { type FormTexts, useApiForm } from './forms';

/**
 * One field of an ApiForm. `name` is a dot path into the JSON body (`limits.maxActiveLearners`).
 * Number fields send numbers; an empty optional field is left out, or sent as null with `emptyAs`.
 */
export type ApiField = {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  emptyAs?: 'omit' | 'null';
} & (
  | {
      kind: 'text' | 'email' | 'password' | 'number' | 'date' | 'month';
      defaultValue?: string | number | null;
      autoComplete?: string;
      transform?: 'upper' | 'lower';
    }
  | { kind: 'textarea'; rows?: number; defaultValue?: string | null }
  | { kind: 'select'; options: { value: string; label: string }[]; defaultValue?: string }
  | { kind: 'checkbox'; defaultValue?: boolean }
  /** Comma-separated text sent as an array of strings. */
  | { kind: 'list'; defaultValue?: string[] }
  /** A group of checkboxes sent as the array of checked values. */
  | { kind: 'multi'; options: { value: string; label: string }[]; defaultValue?: string[] }
  | { kind: 'file'; accept?: string }
);

export interface ApiFormProps {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  fields: ApiField[];
  /** Fixed values merged into the body before the fields. */
  body?: Record<string, unknown>;
  submitLabel: string;
  texts: FormTexts;
  /** Shown after success; `{key}` is filled from the response (and from the body). */
  successMessage?: string;
  /** After success: refresh the page (default) or go somewhere (`{id}` is filled from the response). */
  then?: 'refresh' | { navigate: string } | 'stay';
  /** Keep the values after success (settings) instead of clearing the form (create forms). */
  keepValues?: boolean;
  /** Lays the fields out side by side on wide screens. */
  columns?: 1 | 2;
  testId?: string;
  /** Console forms: strings for the TOTP prompt when the API asks for re-authentication (04 §17.5). */
  reauth?: { title: string; body: string; code: string; verify: string; close: string };
}

type Values = Record<string, string | boolean | string[]>;

const initialValues = (fields: ApiField[]): Values =>
  Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.kind === 'checkbox'
        ? (field.defaultValue ?? false)
        : field.kind === 'multi'
          ? (field.defaultValue ?? [])
          : field.kind === 'list'
            ? (field.defaultValue ?? []).join(', ')
            : field.kind === 'file'
              ? ''
              : field.defaultValue === undefined || field.defaultValue === null
                ? ''
                : String(field.defaultValue),
    ]),
  );

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
}

/** A form whose fields become one JSON request; errors map back onto the fields (06 §2.7). */
export function ApiForm({
  method,
  path,
  fields,
  body,
  submitLabel,
  texts,
  successMessage,
  then = 'refresh',
  keepValues = false,
  columns = 1,
  testId,
  reauth,
}: ApiFormProps) {
  const router = useRouter();
  const form = useApiForm(texts);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);

  /** Sends the request; on REAUTH_REQUIRED asks for a TOTP code and retries once. */
  async function send(sent: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
    const first = await callApi<Record<string, unknown>>(method, path, sent);
    if (first.ok || first.problem.code !== 'REAUTH_REQUIRED' || reauth === undefined) return first;
    const confirmed = await new Promise<boolean>((resolve) => setVerifying(() => resolve));
    return confirmed ? callApi<Record<string, unknown>>(method, path, sent) : first;
  }

  async function verify(): Promise<void> {
    setChecking(true);
    const result = await callApi('POST', '/api/console/auth/reauth', { code: code.trim() });
    setChecking(false);
    if (!result.ok) {
      setCodeError(splitProblem(result.problem, texts.networkError).summary ?? result.problem.title);
      return;
    }
    setCode('');
    setCodeError(undefined);
    verifying?.(true);
    setVerifying(null);
  }

  const set = (name: string, value: string | boolean | string[]) =>
    setValues((v) => ({ ...v, [name]: value }));

  async function payload(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = structuredClone(body ?? {});
    for (const field of fields) {
      if (field.kind === 'file') {
        const file = files[field.name];
        if (file) setPath(result, field.name, await file.text());
        continue;
      }
      const raw = values[field.name];
      if (field.kind === 'checkbox') {
        setPath(result, field.name, raw === true);
        continue;
      }
      if (field.kind === 'multi') {
        setPath(result, field.name, Array.isArray(raw) ? raw : []);
        continue;
      }
      if (field.kind === 'list') {
        const items =
          typeof raw === 'string'
            ? raw
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : [];
        setPath(result, field.name, items);
        continue;
      }
      let value = typeof raw === 'string' ? raw.trim() : '';
      if (value === '') {
        if (field.emptyAs === 'null') setPath(result, field.name, null);
        continue;
      }
      if ('transform' in field && field.transform === 'upper') value = value.toUpperCase();
      if ('transform' in field && field.transform === 'lower') value = value.toLowerCase();
      setPath(result, field.name, field.kind === 'number' ? Number(value) : value);
    }
    return result;
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid={testId}
      onSubmit={async (event) => {
        setSuccess(null);
        // form.submit prevents the native submit synchronously; the payload (files) is read inside.
        let sent: Record<string, unknown> = {};
        const data = await form.submit(event, async () => {
          sent = await payload();
          return send(sent);
        });
        if (data === null) return;
        const vars = Object.fromEntries(
          Object.entries({ ...sent, ...(data ?? {}) }).filter(
            (entry): entry is [string, string | number] =>
              typeof entry[1] === 'string' || typeof entry[1] === 'number',
          ),
        );
        if (successMessage !== undefined) setSuccess(fill(successMessage, vars));
        if (!keepValues) {
          setValues(initialValues(fields));
          setFiles({});
        }
        if (typeof then === 'object') router.push(fill(then.navigate, vars));
        else if (then === 'refresh') router.refresh();
      }}
    >
      {form.feedback}
      {success !== null ? <Alert tone="success" role="status" title={success} /> : null}
      <div className={columns === 2 ? 'grid gap-4 md:grid-cols-2' : 'flex flex-col gap-4'}>
        {fields.map((field) => {
          const id = `${testId ?? 'form'}-${field.name.replace(/\./g, '-')}`;
          const common = {
            id,
            label: field.label,
            ...(field.hint !== undefined && { hint: field.hint }),
            error: form.fieldError(field.name),
          };
          switch (field.kind) {
            case 'textarea':
              return (
                <div key={field.name} className={columns === 2 ? 'md:col-span-2' : undefined}>
                  <TextArea
                    {...common}
                    rows={field.rows ?? 3}
                    value={values[field.name] as string}
                    onChange={(event) => set(field.name, event.target.value)}
                    required={field.required === true}
                  />
                </div>
              );
            case 'select':
              return (
                <Select
                  key={field.name}
                  id={id}
                  label={field.label}
                  {...(field.hint !== undefined && { hint: field.hint })}
                  options={field.options}
                  value={values[field.name] as string}
                  onValueChange={(value) => set(field.name, value)}
                />
              );
            case 'checkbox':
              return (
                <Checkbox
                  key={field.name}
                  id={id}
                  label={field.label}
                  {...(field.hint !== undefined && { hint: field.hint })}
                  checked={values[field.name] === true}
                  onCheckedChange={(checked) => set(field.name, checked)}
                />
              );
            case 'multi': {
              const checked = values[field.name] as string[];
              return (
                <fieldset key={field.name} className="flex flex-col gap-2">
                  <legend className="mb-1 text-label">{field.label}</legend>
                  {field.options.map((option) => (
                    <Checkbox
                      key={option.value}
                      id={`${id}-${option.value.replace(/[^a-z0-9]/gi, '-')}`}
                      label={option.label}
                      checked={checked.includes(option.value)}
                      onCheckedChange={(on) =>
                        set(
                          field.name,
                          on ? [...checked, option.value] : checked.filter((value) => value !== option.value),
                        )
                      }
                    />
                  ))}
                  {form.fieldError(field.name) !== undefined ? (
                    <span className="text-body-sm text-danger">{form.fieldError(field.name)}</span>
                  ) : null}
                </fieldset>
              );
            }
            case 'file':
              return (
                <TextField
                  key={field.name}
                  {...common}
                  type="file"
                  accept={field.accept}
                  onChange={(event) =>
                    setFiles((f) => ({ ...f, [field.name]: event.target.files?.[0] ?? null }))
                  }
                  required={field.required === true}
                />
              );
            default:
              return (
                <TextField
                  key={field.name}
                  {...common}
                  type={field.kind === 'list' ? 'text' : field.kind}
                  {...(field.kind === 'number' && { inputMode: 'numeric' as const })}
                  autoComplete={('autoComplete' in field && field.autoComplete) || 'off'}
                  value={values[field.name] as string}
                  onChange={(event) => set(field.name, event.target.value)}
                  required={field.required === true}
                />
              );
          }
        })}
      </div>
      <div>
        <Button type="submit" variant="primary" loading={form.busy}>
          {submitLabel}
        </Button>
      </div>
      {reauth !== undefined ? (
        <Dialog
          open={verifying !== null}
          onOpenChange={(open) => {
            if (!open) {
              verifying?.(false);
              setVerifying(null);
            }
          }}
          title={reauth.title}
          description={reauth.body}
          closeLabel={reauth.close}
          footer={
            <Button variant="primary" loading={checking} onClick={() => void verify()}>
              {reauth.verify}
            </Button>
          }
        >
          <TextField
            id={`${testId ?? 'form'}-reauth-code`}
            label={reauth.code}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            error={codeError}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </Dialog>
      ) : null}
    </form>
  );
}
