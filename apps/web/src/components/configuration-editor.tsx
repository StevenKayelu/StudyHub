'use client';

import {
  configurationImportPreviewSchema,
  configurationViewSchema,
  MANAGED_CONTENT_DESCRIPTIONS,
  MANAGED_CONTENT_KEYS,
  MANAGED_CONTENT_LABELS,
  type ConfigurationImportPreview,
  type ConfigurationView,
  type ManagedContentKey,
  type ManagedContentValues,
} from '@studyhub/contracts';
import { Alert, Button, Card, Checkbox, Dialog, Select, TextArea, TextField } from '@studyhub/ui';
import { useState } from 'react';

import { type ApiResult, callApi, type Problem, splitProblem } from '../lib/client-api';

const SOURCES = {
  PLATFORM_DEFAULT: 'Platform default',
  SCHOOL_OVERRIDE: 'School override',
  PLATFORM_ENFORCED: 'Enforced by platform',
} as const;

function display(value: string | boolean | null | undefined): string {
  if (value === undefined || value === null) return 'Inherit';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return value === 'MEMBERS_ONLY' ? 'Members only' : value === 'PUBLIC' ? 'Public' : value;
}

function signature(values: ManagedContentValues, lockedKeys: ManagedContentKey[], reason: string): string {
  return JSON.stringify([
    MANAGED_CONTENT_KEYS.map((key) => values[key] ?? null),
    [...lockedKeys].sort(),
    reason.trim(),
  ]);
}

/** Reviewable, versioned content defaults shared by school and platform settings. */
export function ConfigurationEditor({ initial }: { initial: ConfigurationView }) {
  const [view, setView] = useState(initial);
  const [values, setValues] = useState<ManagedContentValues>(initial.draft?.values ?? initial.values);
  const [lockedKeys, setLockedKeys] = useState<ManagedContentKey[]>(
    initial.scope === 'PLATFORM' ? (initial.draft?.lockedKeys ?? initial.lockedKeys) : [],
  );
  const [reason, setReason] = useState(initial.draft?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ConfigurationImportPreview | null>(null);
  const [verifying, setVerifying] = useState<((confirmed: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const platform = view.scope === 'PLATFORM';
  const path = platform ? '/api/console/configuration' : '/api/v1/admin/configuration';
  const draft = view.draft;
  const saved =
    draft !== null &&
    signature(values, lockedKeys, reason) === signature(draft.values, draft.lockedKeys, draft.reason);

  function fail(problem: Problem) {
    const parsed = splitProblem(problem, 'Could not connect. Try again.');
    setErrors(parsed.fields);
    setMessage({
      tone: 'danger',
      text:
        problem.status === 409
          ? 'Configuration changed. Reload current settings, review your draft, and save it again.'
          : (parsed.summary ?? (Object.values(parsed.fields).join(' ') || 'Check the highlighted fields.')),
    });
  }

  async function send(
    method: 'PUT' | 'POST',
    suffix: string,
    body: unknown,
  ): Promise<ApiResult<ConfigurationView>> {
    const result = await callApi<ConfigurationView>(method, `${path}${suffix}`, body);
    if (result.ok || result.problem.code !== 'REAUTH_REQUIRED' || !platform) return result;
    setCode('');
    setCodeError(undefined);
    const confirmed = await new Promise<boolean>((resolve) => setVerifying(() => resolve));
    return confirmed ? callApi<ConfigurationView>(method, `${path}${suffix}`, body) : result;
  }

  async function verify() {
    setChecking(true);
    const result = await callApi('POST', '/api/console/auth/reauth', { code: code.trim() });
    setChecking(false);
    if (!result.ok) {
      setCodeError(
        splitProblem(result.problem, 'Could not connect. Try again.').summary ?? result.problem.title,
      );
      return;
    }
    verifying?.(true);
    setVerifying(null);
    setCode('');
  }

  async function save() {
    setMessage(null);
    setErrors({});
    if (reason.trim().length < 3 || reason.trim().length > 300) {
      setErrors({ reason: 'Enter a reason between 3 and 300 characters.' });
      setMessage({ tone: 'danger', text: 'Enter a reason before saving the draft.' });
      return;
    }
    setBusy(true);
    const result = await send('PUT', '/draft', {
      expectedRevision: view.revision,
      values,
      lockedKeys: platform ? lockedKeys : [],
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) return fail(result.problem);
    const next = configurationViewSchema.parse(result.data);
    setView(next);
    setValues(next.draft?.values ?? next.values);
    setLockedKeys(platform ? (next.draft?.lockedKeys ?? next.lockedKeys) : []);
    setReason(next.draft?.reason ?? '');
    setMessage({ tone: 'success', text: 'Draft saved. Review the proposed settings before activation.' });
  }

  async function activate() {
    if (draft === null || !saved || draft.stale) return;
    setBusy(true);
    setMessage(null);
    setErrors({});
    const result = await send('POST', '/activate', {
      draftId: draft.id,
      expectedRevision: draft.baseRevision,
    });
    setBusy(false);
    if (!result.ok) return fail(result.problem);
    const next = configurationViewSchema.parse(result.data);
    setView(next);
    setValues(next.values);
    setLockedKeys(platform ? next.lockedKeys : []);
    setReason('');
    setMessage({ tone: 'success', text: 'Configuration activated.' });
  }

  async function reload() {
    setBusy(true);
    const result = await callApi<ConfigurationView>('GET', path);
    setBusy(false);
    if (!result.ok) return fail(result.problem);
    setView(configurationViewSchema.parse(result.data));
    setMessage({ tone: 'info', text: 'Current settings reloaded. Your local edits are kept for review.' });
  }

  function setValue(key: ManagedContentKey, raw: string) {
    setValues((current) => {
      const next = { ...current };
      if (raw === 'inherit') delete next[key];
      else if (key === 'catalogVisibility') next[key] = raw as 'PUBLIC' | 'MEMBERS_ONLY';
      else next[key] = raw === 'true';
      return next;
    });
  }

  function useValues(candidate: ManagedContentValues): ManagedContentValues {
    const next = { ...candidate };
    if (!platform) {
      // Enforced settings can reset to inheritance, but cannot receive another override value.
      for (const field of view.fields) {
        if (!field.locked) continue;
        const current = view.values[field.key];
        if (candidate[field.key] !== undefined && candidate[field.key] !== current) {
          delete next[field.key];
          if (current !== undefined) Object.assign(next, { [field.key]: current });
        }
      }
    }
    return next;
  }

  async function importFile(file: File) {
    setPreview(null);
    setMessage(null);
    if (file.size > 32_768) {
      setMessage({ tone: 'danger', text: 'Choose a configuration file smaller than 32 KB.' });
      return;
    }
    setBusy(true);
    try {
      // Only text goes to the strict allowlist parser; there is no raw-file upload or persistence.
      const result = await callApi('POST', `${path}/import-preview`, { text: await file.text() });
      if (!result.ok) fail(result.problem);
      else setPreview(configurationImportPreviewSchema.parse(result.data));
    } catch {
      setMessage({ tone: 'danger', text: 'The configuration file could not be read.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5" data-testid="configuration-editor">
      <div>
        <h2 className="text-h2">Content configuration</h2>
        <p className="mt-1 max-w-reading text-body-sm text-muted">
          {platform
            ? 'Set platform defaults and choose which values schools must follow.'
            : 'Inherit platform defaults or set school overrides. Platform enforcement takes priority.'}{' '}
          Save a draft, review it, then activate it.
        </p>
      </div>
      {message !== null ? (
        <Alert tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
          {message.text}
        </Alert>
      ) : null}
      {draft !== null ? (
        <Alert tone={draft.stale ? 'warning' : 'info'}>
          {draft.stale
            ? 'This saved draft is based on older settings. Review current settings and save it again before activation.'
            : 'A saved draft is loaded. Changes take effect only after activation.'}
        </Alert>
      ) : null}
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {view.fields.map((field) => {
            const enforced = !platform && field.locked;
            const options =
              field.key === 'catalogVisibility'
                ? [
                    { value: 'PUBLIC', label: 'Public' },
                    { value: 'MEMBERS_ONLY', label: 'Members only' },
                  ]
                : [
                    { value: 'true', label: 'Yes' },
                    { value: 'false', label: 'No' },
                  ];
            return (
              <fieldset
                key={field.key}
                className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-4"
              >
                <legend className="px-1 text-h3">{MANAGED_CONTENT_LABELS[field.key]}</legend>
                <p className="text-body-sm text-muted">{MANAGED_CONTENT_DESCRIPTIONS[field.key]}</p>
                <dl className="grid grid-cols-2 gap-1 text-body-sm">
                  <dt>Effective now</dt>
                  <dd className="font-medium">{display(field.value)}</dd>
                  <dt>Inherited</dt>
                  <dd>{display(field.inheritedValue)}</dd>
                  <dt>Stored override</dt>
                  <dd>{display(field.overrideValue)}</dd>
                  <dt>Source</dt>
                  <dd>{SOURCES[field.source]}</dd>
                </dl>
                {!platform && field.locked ? (
                  <p className="text-body-sm text-muted">
                    Locked by the platform. A stored school override is inactive while enforced. Choose
                    Inherit to remove it.
                  </p>
                ) : null}
                <Select
                  id={`configuration-${field.key}`}
                  label={`Proposed ${MANAGED_CONTENT_LABELS[field.key].toLowerCase()}`}
                  value={values[field.key] === undefined ? 'inherit' : String(values[field.key])}
                  onValueChange={(value) => setValue(field.key, value)}
                  disabled={busy}
                  options={[
                    { value: 'inherit', label: `Inherit (${display(field.inheritedValue)})` },
                    ...options.map((option) => ({
                      ...option,
                      disabled: enforced && option.value !== String(view.values[field.key]),
                    })),
                  ]}
                />
                {errors[`values.${field.key}`] !== undefined ? (
                  <p className="text-body-sm text-danger">{errors[`values.${field.key}`]}</p>
                ) : null}
                {platform ? (
                  <Checkbox
                    label={`Enforce ${MANAGED_CONTENT_LABELS[field.key].toLowerCase()} for every school`}
                    checked={lockedKeys.includes(field.key)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setLockedKeys((keys) =>
                        checked ? [...keys, field.key] : keys.filter((key) => key !== field.key),
                      )
                    }
                  />
                ) : null}
                <p className="text-caption text-muted">
                  {field.effect === 'NEW_CONTENT'
                    ? 'Applies to new content. Existing content keeps its setting.'
                    : 'Applies on the next request after activation.'}
                </p>
              </fieldset>
            );
          })}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-body-sm" data-testid="configuration-review">
            <caption className="mb-2 text-left text-h3">Review active → proposed</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="p-2">
                  Setting
                </th>
                <th scope="col" className="p-2">
                  Active
                </th>
                <th scope="col" className="p-2">
                  Proposed effective
                </th>
                {platform ? (
                  <th scope="col" className="p-2">
                    Enforcement
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {view.fields.map((field) => (
                <tr key={field.key} className="border-b border-line">
                  <th scope="row" className="p-2 font-medium">
                    {MANAGED_CONTENT_LABELS[field.key]}
                  </th>
                  <td className="p-2">{display(field.value)}</td>
                  <td className="p-2">
                    {display(
                      !platform && field.locked ? field.value : (values[field.key] ?? field.inheritedValue),
                    )}
                    {!platform && field.locked
                      ? ' (platform enforced)'
                      : values[field.key] === undefined
                        ? ' (inherited)'
                        : ''}
                  </td>
                  {platform ? (
                    <td className="p-2">
                      {view.lockedKeys.includes(field.key) ? 'Enforced' : 'Optional'} →{' '}
                      {lockedKeys.includes(field.key) ? 'Enforced' : 'Optional'}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TextArea
          label="Reason for this configuration change"
          hint="Required, 3–300 characters. Included in the activation history."
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={errors.reason}
          required
          disabled={busy}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" loading={busy}>
            Save configuration draft
          </Button>
          <Button onClick={() => void activate()} disabled={busy || !saved || draft === null || draft.stale}>
            Activate saved draft
          </Button>
          <Button onClick={() => void reload()} disabled={busy}>
            Reload current settings
          </Button>
        </div>
        {!saved ? (
          <p className="text-body-sm text-muted">Save your current values and reason before activation.</p>
        ) : null}
      </form>
      <details className="rounded-md border border-line p-4">
        <summary className="cursor-pointer text-h3">Import a configuration file</summary>
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-body-sm text-muted">
            Choose a .env text file containing supported content settings. Review its validated values before
            adding them to your draft.
          </p>
          <TextField
            type="file"
            label="Configuration file (.env)"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void importFile(file);
            }}
          />
          {preview !== null ? (
            <div className="flex flex-col gap-3" data-testid="configuration-import-preview">
              <h3 className="text-h3">Validated import preview</h3>
              <ul className="flex flex-col gap-2 text-body-sm">
                {preview.entries.map((entry) => (
                  <li key={entry.key}>
                    {MANAGED_CONTENT_LABELS[entry.setting]}: {entry.displayValue}
                    {!platform && view.fields.some((field) => field.key === entry.setting && field.locked)
                      ? ' — locked by platform; excluded'
                      : ''}
                  </li>
                ))}
              </ul>
              <p className="text-body-sm text-muted">Preview only. Nothing has been saved or activated.</p>
              <Button
                className="self-start"
                onClick={() => {
                  const imported = { ...preview.values };
                  if (!platform) {
                    for (const field of view.fields) if (field.locked) delete imported[field.key];
                  }
                  setValues({ ...values, ...imported });
                  setPreview(null);
                  setMessage({
                    tone: 'info',
                    text: 'Imported values added to the local draft. Review them and enter a reason before saving.',
                  });
                }}
              >
                Use preview in draft
              </Button>
            </div>
          ) : null}
        </div>
      </details>
      <details className="rounded-md border border-line p-4">
        <summary className="cursor-pointer text-h3">Activation history ({view.history.length})</summary>
        <div className="mt-4 flex flex-col gap-3">
          {view.history.length === 0 ? (
            <p className="text-body-sm text-muted">No activations recorded yet.</p>
          ) : null}
          {view.history.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3"
            >
              <div className="min-w-0 text-body-sm">
                <time dateTime={entry.at}>
                  {new Date(entry.at)
                    .toISOString()
                    .replace('T', ' ')
                    .replace(/\.\d+Z$/, ' UTC')}
                </time>
                <p className="break-words">{entry.reason}</p>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  setValues(useValues(entry.values));
                  setLockedKeys(platform ? entry.lockedKeys : []);
                  setReason('');
                  setMessage({
                    tone: 'info',
                    text: platform
                      ? 'Historical values loaded into a local draft. Review them and add a new reason before saving.'
                      : 'Historical values loaded into a local draft. Review them and add a new reason before saving. Locked settings stay within current platform restrictions.',
                  });
                }}
              >
                Review as new draft
              </Button>
            </div>
          ))}
        </div>
      </details>
      <Dialog
        open={verifying !== null}
        onOpenChange={(open) => {
          if (!open) {
            verifying?.(false);
            setVerifying(null);
          }
        }}
        title="Verify your identity"
        description="Enter a code from your authenticator app to activate platform settings."
        closeLabel="Close"
        footer={
          <Button variant="primary" loading={checking} onClick={() => void verify()}>
            Verify
          </Button>
        }
      >
        <TextField
          label="Authenticator code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          error={codeError}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </Dialog>
    </Card>
  );
}
