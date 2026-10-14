'use client';

import type { CategoryTree } from '@studyhub/contracts';
import { Alert, Button, Card, StatusBadge, TextArea } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { type ApiResult, callApi, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

/** One API action with a busy flag, an error message and a page refresh on success. */
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

/** S-AD03 course review: approve and publish, or request changes with notes (F12). */
export function ReviewDecision({ courseId, texts }: { courseId: string; texts: StudioTexts }) {
  const r = texts.admin.reviews;
  const action = useAction(texts);
  const [notes, setNotes] = useState('');
  const id = useId();
  const decide = (decision: 'APPROVED' | 'CHANGES_REQUESTED') =>
    action.run(() =>
      callApi('POST', `/api/v1/admin/courses/${courseId}/review`, {
        decision,
        ...(notes.trim() !== '' && { notes }),
      }),
    );
  return (
    <div className="flex flex-col gap-3">
      {action.feedback}
      <TextArea
        id={id}
        label={r.notes}
        rows={3}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => void decide('APPROVED')}>
          {r.approve}
        </Button>
        <Button
          variant="secondary"
          disabled={action.busy || notes.trim() === ''}
          onClick={() => void decide('CHANGES_REQUESTED')}
        >
          {r.requestChanges}
        </Button>
      </div>
    </div>
  );
}

/** S-AD05 instructor application decision (F06): approve, request changes or reject with a reason. */
export function InstructorDecision({ membershipId, texts }: { membershipId: string; texts: StudioTexts }) {
  const i = texts.admin.instructors;
  const action = useAction(texts);
  const [note, setNote] = useState('');
  const id = useId();
  const decide = (decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED') =>
    action.run(() =>
      callApi('POST', `/api/v1/admin/instructors/${membershipId}/decision`, {
        decision,
        ...(note.trim() !== '' && { note }),
      }),
    );
  return (
    <div className="flex flex-col gap-3">
      {action.feedback}
      <TextArea
        id={id}
        label={i.note}
        rows={2}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => void decide('APPROVED')}>
          {i.approve}
        </Button>
        <Button
          variant="secondary"
          disabled={action.busy || note.trim() === ''}
          onClick={() => void decide('CHANGES_REQUESTED')}
        >
          {i.requestChanges}
        </Button>
        <Button
          variant="ghost"
          disabled={action.busy || note.trim() === ''}
          onClick={() => void decide('REJECTED')}
        >
          {i.reject}
        </Button>
      </div>
    </div>
  );
}

/** Take a published course off the catalogue, with a reason (audited). */
export function UnpublishCourse({ courseId, texts }: { courseId: string; texts: StudioTexts }) {
  const c = texts.admin.courseList;
  const action = useAction(texts);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const id = useId();
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {c.unpublish}
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(() => callApi('POST', `/api/v1/admin/courses/${courseId}/unpublish`, { reason }));
      }}
    >
      {action.feedback}
      <label htmlFor={id} className="flex flex-1 flex-col gap-1 text-label">
        {c.reason}
        <input
          id={id}
          value={reason}
          maxLength={2000}
          required
          onChange={(event) => setReason(event.target.value)}
          className="h-10 rounded-md border border-strong bg-surface px-3 font-normal"
        />
      </label>
      <Button type="submit" size="sm" variant="primary" disabled={action.busy || reason.trim() === ''}>
        {c.unpublish}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {texts.common.cancel}
      </Button>
    </form>
  );
}

function NameForm({
  label,
  submitLabel,
  busy,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const id = useId();
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const name = String(new FormData(form).get('name') ?? '').trim();
        if (name !== '' && (await onSubmit(name))) form.reset();
      }}
    >
      <label htmlFor={id} className="flex flex-1 flex-col gap-1 text-label">
        {label}
        <input
          id={id}
          name="name"
          maxLength={80}
          required
          className="h-10 rounded-md border border-strong bg-surface px-3 font-normal"
        />
      </label>
      <Button type="submit" variant="secondary" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** S-AD06 Categories and subjects (F08): add, archive and restore (archived ones leave the catalogue). */
export function CategoryManager({ tree, texts }: { tree: CategoryTree; texts: StudioTexts }) {
  const c = texts.admin.categories;
  const action = useAction(texts);
  const toggle = (kind: 'categories' | 'subjects', id: string, archived: boolean) =>
    void action.run(() => callApi('PATCH', `/api/v1/admin/${kind}/${id}`, { archived }));
  return (
    <div className="flex flex-col gap-4">
      {action.feedback}
      <Card>
        <NameForm
          label={c.categoryName}
          submitLabel={c.addCategory}
          busy={action.busy}
          onSubmit={(name) => action.run(() => callApi('POST', '/api/v1/admin/categories', { name }))}
        />
      </Card>
      {tree.categories.length === 0 ? <p className="text-muted">{c.empty}</p> : null}
      {tree.categories.map((category) => (
        <Card key={category.id} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-h3">{category.name}</h2>
            {category.archived ? <StatusBadge status="draft">{c.archived}</StatusBadge> : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={action.busy}
              onClick={() => toggle('categories', category.id, !category.archived)}
            >
              {category.archived ? c.restore : c.archive}
            </Button>
          </div>
          {category.subjects.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {category.subjects.map((subject) => (
                <li key={subject.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1">{subject.name}</span>
                  {subject.archived ? <StatusBadge status="draft">{c.archived}</StatusBadge> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => toggle('subjects', subject.id, !subject.archived)}
                  >
                    {subject.archived ? c.restore : c.archive}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <NameForm
            label={c.subjectName}
            submitLabel={c.addSubject}
            busy={action.busy}
            onSubmit={(name) =>
              action.run(() => callApi('POST', '/api/v1/admin/subjects', { categoryId: category.id, name }))
            }
          />
        </Card>
      ))}
    </div>
  );
}
