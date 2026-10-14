'use client';

import type { StudioCourse } from '@studyhub/contracts';
import { Alert, Button } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi, splitProblem } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';

type Action = 'submit' | 'unpublish' | 'publish' | 'archive';

/** S-T08 actions: submit (for review, or straight to published), unpublish, publish again, archive. */
export function PublishActions({
  course,
  ready,
  texts,
}: {
  course: StudioCourse;
  ready: boolean;
  texts: StudioTexts;
}) {
  const router = useRouter();
  const p = texts.studio.publish;
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: Action) {
    setBusy(action);
    setError(null);
    const result = await callApi<StudioCourse>('POST', `/api/v1/studio/courses/${course.id}/${action}`);
    setBusy(null);
    if (result.ok) {
      router.refresh();
      return;
    }
    const split = splitProblem(result.problem, texts.common.networkError);
    setError(split.summary ?? Object.values(split.fields)[0] ?? '');
  }

  const status = course.status;
  return (
    <div className="flex flex-col gap-3">
      {error !== null ? <Alert tone="danger" role="alert" title={error} /> : null}
      <div className="flex flex-wrap gap-2">
        {status === 'DRAFT' || status === 'CHANGES_REQUESTED' ? (
          <Button
            variant="primary"
            disabled={!ready || busy !== null}
            onClick={() => void act('submit')}
            data-testid="submit-course"
          >
            {busy === 'submit' ? p.submitting : p.submit}
          </Button>
        ) : null}
        {status === 'PUBLISHED' ? (
          <Button variant="secondary" disabled={busy !== null} onClick={() => void act('unpublish')}>
            {p.unpublish}
          </Button>
        ) : null}
        {status === 'UNPUBLISHED' ? (
          <Button variant="primary" disabled={busy !== null} onClick={() => void act('publish')}>
            {p.republish}
          </Button>
        ) : null}
        {status === 'DRAFT' || status === 'UNPUBLISHED' || status === 'CHANGES_REQUESTED' ? (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void act('archive')}>
            {p.archive}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
