'use client';

import type { AttemptView } from '@studyhub/contracts';
import { Alert, Button } from '@studyhub/ui';
import { useEffect, useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import type { LearnTexts } from '../lib/learn-texts-type';

/** S-L04 Start: confirms a timed start ("the timer keeps running"); needs a connection to start. */
export function StartAttempt({
  quizId,
  label,
  timed,
  texts,
}: {
  quizId: string;
  label: string;
  timed: boolean;
  texts: LearnTexts;
}) {
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="primary"
        className="self-start"
        disabled={!online || busy}
        data-testid="start-attempt"
        onClick={async () => {
          if (timed && !window.confirm(texts.quiz.confirmTimed)) return;
          setBusy(true);
          setError(null);
          const result = await callApi<AttemptView>('POST', `/api/v1/learn/quizzes/${quizId}/attempts`);
          if (result.ok) {
            reloadTo(`/learn/attempts/${result.data.id}`);
            return;
          }
          setBusy(false);
          setError(splitProblem(result.problem, texts.common.networkError).summary);
        }}
      >
        {busy ? texts.quiz.starting : label}
      </Button>
      {!online ? <p className="text-body-sm text-muted">{texts.quiz.offlineStart}</p> : null}
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
