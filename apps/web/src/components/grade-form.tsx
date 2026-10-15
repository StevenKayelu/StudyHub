'use client';

import { formatMessage } from '@studyhub/contracts';
import { Alert, Button } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

/** S-T10 grading: points (0–max) and a comment for one long answer; "Save & next" refreshes the queue. */
export function GradeForm({
  attemptId,
  itemId,
  max,
  texts,
}: {
  attemptId: string;
  itemId: string;
  max: number;
  texts: StudioTexts;
}) {
  const g = texts.studio.results;
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      method="post"
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);
        const result = await callApi('PUT', `/api/v1/studio/attempts/${attemptId}/items/${itemId}/grade`, {
          points: Number(data.get('points')),
          comment: String(data.get('comment') ?? ''),
        });
        setBusy(false);
        if (result.ok) router.refresh();
        else {
          const split = splitProblem(result.problem, texts.common.networkError);
          setError(split.summary ?? Object.values(split.fields).join(' '));
        }
      }}
    >
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={`${id}-points`} className="flex flex-col gap-1 text-label">
          {formatMessage(g.award, { max })}
          <input
            id={`${id}-points`}
            name="points"
            inputMode="decimal"
            required
            className="h-11 w-28 rounded-md border border-strong bg-surface px-3 font-normal"
          />
        </label>
        <label htmlFor={`${id}-comment`} className="flex min-w-0 flex-1 flex-col gap-1 text-label">
          {g.comment}
          <input
            id={`${id}-comment`}
            name="comment"
            maxLength={4000}
            className="h-11 rounded-md border border-strong bg-surface px-3 font-normal"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {g.saveGrade}
        </Button>
      </div>
    </form>
  );
}
