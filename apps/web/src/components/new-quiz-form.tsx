'use client';

import type { QuizView } from '@studyhub/contracts';
import { Alert, Button } from '@studyhub/ui';
import { useId, useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

/** Creates a quiz (with the school's quiz defaults, BR-64) and opens its builder. */
export function NewQuizForm({ courseId, texts }: { courseId: string; texts: StudioTexts }) {
  const z = texts.studio.quizzes;
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      method="post"
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={async (event) => {
        event.preventDefault();
        const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
        setBusy(true);
        setError(null);
        const result = await callApi<QuizView>('POST', `/api/v1/studio/courses/${courseId}/quizzes`, {
          title,
        });
        setBusy(false);
        if (result.ok) reloadTo(`/studio/courses/${courseId}/quizzes/${result.data.id}`);
        else setError(splitProblem(result.problem, texts.common.networkError).summary);
      }}
    >
      <label htmlFor={id} className="flex flex-1 flex-col gap-1 text-label">
        {z.quizTitle}
        <input
          id={id}
          name="title"
          required
          maxLength={120}
          className="h-11 rounded-md border border-strong bg-surface px-3 font-normal"
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy}>
        {z.create}
      </Button>
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
    </form>
  );
}
