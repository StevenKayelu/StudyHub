'use client';

import type { PeriodKind, PeriodMode } from '@studyhub/contracts';
import { Alert, Button, Card, Select, StatusBadge, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { type ApiResult, callApi, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

/** A period as the Terms page lists it; labels are formatted on the server (dates, plurals). */
export interface PeriodRow {
  id: string;
  name: string;
  kind: PeriodKind;
  mode: PeriodMode;
  startsAt: string;
  endsAt: string | null;
  open: boolean;
  archived: boolean;
  datesLabel: string;
  statusLabel: string;
  courseCountLabel: string;
}

const KINDS: PeriodKind[] = ['TERM', 'SEMESTER', 'SEMINAR'];
const MODES: PeriodMode[] = ['AUTO', 'OPEN', 'LOCKED'];

/** `yyyy-mm-dd` from a date input → midnight in the administrator's time zone (PROPOSED 7). */
function startOfDay(value: string): string {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toISOString();
}

/** An instant → the `yyyy-mm-dd` the administrator's date input shows. */
function dateInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function useAction(texts: StudioTexts) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: () => Promise<ApiResult<unknown>>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (result.ok) {
        router.refresh();
        return true;
      }
      const split = splitProblem(result.problem, texts.common.networkError);
      setError(split.summary ?? Object.values(split.fields)[0] ?? '');
      return false;
    } finally {
      setBusy(false);
    }
  }
  const feedback = error !== null ? <Alert tone="danger" role="alert" title={error} /> : null;
  return { busy, run, feedback };
}

/** Name, type and dates of a period: the "Add term" form, and the edit form of one period. */
function PeriodForm({
  texts,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  texts: StudioTexts;
  initial?: PeriodRow;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: {
    name: string;
    kind: PeriodKind;
    startsAt: string;
    endsAt: string | null;
  }) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const p = texts.admin.periods;
  const [kind, setKind] = useState<PeriodKind>(initial?.kind ?? 'TERM');
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const name = String(data.get('name') ?? '').trim();
        const starts = String(data.get('startsOn') ?? '');
        const ends = String(data.get('endsOn') ?? '');
        if (name === '' || starts === '') return;
        const saved = await onSubmit({
          name,
          kind,
          startsAt: startOfDay(starts),
          endsAt: ends === '' ? null : startOfDay(ends),
        });
        if (saved && initial === undefined) form.reset();
      }}
    >
      <TextField
        name="name"
        label={p.name}
        placeholder={p.namePlaceholder}
        maxLength={80}
        required
        defaultValue={initial?.name}
      />
      <Select
        label={p.kind}
        value={kind}
        onValueChange={(value) => setKind(value as PeriodKind)}
        options={KINDS.map((value) => ({ value, label: p.kinds[value] }))}
      />
      <TextField
        name="startsOn"
        type="date"
        label={p.startsOn}
        required
        defaultValue={dateInput(initial?.startsAt ?? null)}
      />
      <TextField
        name="endsOn"
        type="date"
        label={p.endsOn}
        hint={p.endsHint}
        defaultValue={dateInput(initial?.endsAt ?? null)}
      />
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant={initial === undefined ? 'primary' : 'secondary'} disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel !== undefined ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {p.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PeriodItem({ period, texts }: { period: PeriodRow; texts: StudioTexts }) {
  const p = texts.admin.periods;
  const action = useAction(texts);
  const [editing, setEditing] = useState(false);
  const patch = (body: Record<string, unknown>) =>
    action.run(() => callApi('PATCH', `/api/v1/admin/periods/${period.id}`, body));
  return (
    <Card className="flex flex-col gap-3" data-testid={`period-${period.id}`}>
      {action.feedback}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-h3">{period.name}</h2>
          <span className="text-caption text-muted">
            {p.kinds[period.kind]} · {period.datesLabel} · {period.courseCountLabel}
          </span>
        </div>
        {period.archived ? (
          <StatusBadge status="draft">{p.archived}</StatusBadge>
        ) : (
          <StatusBadge status={period.open ? 'published' : 'pending'}>{period.statusLabel}</StatusBadge>
        )}
      </div>
      {editing ? (
        <PeriodForm
          texts={texts}
          initial={period}
          submitLabel={p.save}
          busy={action.busy}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const saved = await patch(body);
            if (saved) setEditing(false);
            return saved;
          }}
        />
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          {period.archived ? null : (
            <div className="min-w-56">
              <Select
                label={p.modeLabel}
                value={period.mode}
                disabled={action.busy}
                onValueChange={(mode) => void patch({ mode })}
                options={MODES.map((value) => ({ value, label: p.modes[value] }))}
              />
            </div>
          )}
          <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setEditing(true)}>
            {p.edit}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() => void patch({ archived: !period.archived })}
          >
            {period.archived ? p.restore : p.archive}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Terms & semesters (docs/design/course-periods.md): add, edit, open or lock, archive. */
export function PeriodManager({ periods, texts }: { periods: PeriodRow[]; texts: StudioTexts }) {
  const p = texts.admin.periods;
  const action = useAction(texts);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">{p.intro}</p>
      {action.feedback}
      <Card>
        <PeriodForm
          texts={texts}
          submitLabel={p.add}
          busy={action.busy}
          onSubmit={(body) => action.run(() => callApi('POST', '/api/v1/admin/periods', body))}
        />
      </Card>
      {periods.length === 0 ? <p className="text-muted">{p.empty}</p> : null}
      {periods.map((period) => (
        <PeriodItem key={period.id} period={period} texts={texts} />
      ))}
    </div>
  );
}

/** One course's term and access on the admin course list. */
export function CoursePeriodControl({
  courseId,
  periodId,
  accessOverride,
  periods,
  texts,
}: {
  courseId: string;
  periodId: string | null;
  accessOverride: 'OPEN' | 'LOCKED' | null;
  periods: { id: string; name: string }[];
  texts: StudioTexts;
}) {
  const c = texts.admin.courseList;
  const action = useAction(texts);
  const save = (body: Record<string, unknown>) =>
    void action.run(() => callApi('PATCH', `/api/v1/admin/courses/${courseId}/period`, body));
  // A course may sit in an archived period: keep it selectable so the select shows it.
  const options = [
    { value: 'open', label: c.openCourse },
    ...periods.map((p) => ({ value: p.id, label: p.name })),
  ];
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end">
      {action.feedback}
      <div className="flex-1">
        <Select
          label={c.period}
          value={periodId ?? 'open'}
          disabled={action.busy}
          onValueChange={(value) => save({ periodId: value === 'open' ? null : value })}
          options={options}
        />
      </div>
      <div className="flex-1">
        <Select
          label={c.override}
          value={accessOverride ?? 'FOLLOW'}
          disabled={action.busy}
          onValueChange={(value) => save({ accessOverride: value === 'FOLLOW' ? null : value })}
          options={(['FOLLOW', 'OPEN', 'LOCKED'] as const).map((value) => ({
            value,
            label: c.overrides[value],
          }))}
        />
      </div>
    </div>
  );
}
