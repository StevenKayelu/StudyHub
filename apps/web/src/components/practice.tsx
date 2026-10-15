'use client';

import {
  type AnswerResponse,
  type AttemptView,
  formatMessage,
  type PracticeFeedback,
  type PracticeSetup,
  type PracticeSummary,
} from '@studyhub/contracts';
import { Alert, Button, Card } from '@studyhub/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import NextLink from 'next/link';
import { useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import type { LearnTexts } from '../lib/learn-texts-type';
import { QuestionInput } from './question-input';
import { RichText } from './rich-text';

const field = 'h-11 rounded-md border border-strong bg-surface px-3 font-normal';

async function startPractice(courseId: string, body: Record<string, unknown>) {
  return callApi<AttemptView>('POST', `/api/v1/learn/courses/${courseId}/practice`, body);
}

/** S-L07 setup: how many, which topics, difficulty, "only my mistakes". */
export function PracticeSetupForm({ setup, texts }: { setup: PracticeSetup; texts: LearnTexts }) {
  const p = texts.practice;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = [...new Set([5, 10, 20, setup.defaultCount])].sort((a, b) => a - b);
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);
        const result = await startPractice(setup.courseId, {
          count: Number(data.get('count')),
          tags: data.getAll('tags').map(String),
          ...(data.get('difficulty') !== '' && { difficulty: data.get('difficulty') }),
          mistakesOnly: data.get('mistakesOnly') === 'on',
        });
        if (result.ok) {
          reloadTo(`/learn/practice/${result.data.id}`);
          return;
        }
        setBusy(false);
        setError(splitProblem(result.problem, texts.common.networkError).summary);
      }}
    >
      <label className="flex flex-col gap-1 text-label">
        {p.count}
        <select name="count" defaultValue={String(setup.defaultCount)} className={`${field} w-32`}>
          {counts.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {setup.tags.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-label">{p.topics}</legend>
          <div className="flex flex-wrap gap-2">
            {setup.tags.map((tag) => (
              <label
                key={tag}
                className="flex min-h-11 items-center gap-2 rounded-full border border-line px-3"
              >
                <input type="checkbox" name="tags" value={tag} className="size-4" />
                {tag}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <label className="flex flex-col gap-1 text-label">
        {p.difficulty}
        <select name="difficulty" defaultValue="" className={`${field} w-48`}>
          <option value="">{p.anyDifficulty}</option>
          {(['EASY', 'MEDIUM', 'HARD'] as const).map((d) => (
            <option key={d} value={d}>
              {texts.assessment.difficulties[d]}
            </option>
          ))}
        </select>
      </label>
      {setup.mistakesModeEnabled ? (
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="mistakesOnly"
            disabled={setup.mistakesAvailable === 0}
            className="size-5"
          />
          {p.mistakesOnly}
          {setup.mistakesAvailable === 0 ? (
            <span className="text-caption text-muted">({p.mistakesNone})</span>
          ) : null}
        </label>
      ) : null}
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" variant="primary" className="self-start" disabled={busy}>
        {p.start}
      </Button>
    </form>
  );
}

function describe(question: AttemptView['items'][number]['question'], correct: unknown): string {
  const c = correct as {
    optionIds?: string[];
    acceptedAnswers?: string[];
    value?: number | null;
    tolerance?: number;
  } | null;
  if (c === null) return '';
  if (c.optionIds !== undefined)
    return question.options
      .filter((o) => c.optionIds!.includes(o.id))
      .map((o) => o.content)
      .join(', ');
  if (c.acceptedAnswers !== undefined) return c.acceptedAnswers.join(' / ');
  if (c.value !== undefined && c.value !== null) {
    return `${c.value}${c.tolerance ? ` ± ${c.tolerance}` : ''}${question.unit !== undefined ? ` ${question.unit}` : ''}`;
  }
  return '';
}

/** S-L07 session: the runner without a timer, with immediate feedback after "Check"; then the summary. */
export function PracticeRunner({ attempt, texts }: { attempt: AttemptView; texts: LearnTexts }) {
  const r = texts.runner;
  const p = texts.practice;
  const firstOpen = attempt.items.findIndex((i) => attempt.feedback[i.id] === undefined);
  const [index, setIndex] = useState(firstOpen === -1 ? attempt.items.length - 1 : firstOpen);
  const [answers, setAnswers] = useState<Record<string, AnswerResponse>>({});
  const [feedback, setFeedback] = useState<Record<string, PracticeFeedback>>(attempt.feedback);
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = attempt.items[index]!;
  const result = feedback[item.id];

  if (summary !== null) {
    return (
      <div data-testid="practice-summary">
        <Card className="flex flex-col gap-4 p-5">
          <h2 className="text-h2">{p.summaryTitle}</h2>
          <p className="tabular text-h3">{`${summary.percent} %`}</p>
          <p className="text-muted">
            {formatMessage(p.summaryScore, {
              correct: Object.values(feedback).filter((f) => f.isCorrect).length,
              answered: summary.answered,
            })}
          </p>
          {summary.weakTags.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-h3">{p.weakTopics}</h3>
              <ul className="flex flex-wrap gap-2">
                {summary.weakTags.map((tag) => (
                  <li key={tag.tag} className="rounded-full border border-line px-3 py-1 text-body-sm">
                    {tag.tag} · {tag.correct}/{tag.total}
                  </li>
                ))}
              </ul>
              <Button
                variant="primary"
                className="self-start"
                onClick={async () => {
                  const next = await startPractice(summary.courseId, {
                    tags: summary.weakTags.map((t) => t.tag),
                  });
                  if (next.ok) reloadTo(`/learn/practice/${next.data.id}`);
                }}
              >
                {p.practiseThese}
              </Button>
            </div>
          ) : null}
          <NextLink href={`/learn/courses/${summary.courseId}/practice`} className="self-start">
            {p.again}
          </NextLink>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-caption text-muted">
        {formatMessage(r.questionOf, { number: index + 1, total: attempt.items.length })}
      </p>
      <QuestionInput
        key={item.id}
        question={item.question}
        value={answers[item.id] ?? null}
        onChange={(response) => setAnswers({ ...answers, [item.id]: response })}
        texts={texts}
        disabled={result !== undefined}
        heading={formatMessage(r.questionOf, { number: index + 1, total: attempt.items.length })}
      />
      {result !== undefined ? (
        <div
          role="status"
          className={`flex flex-col gap-2 rounded-md border p-4 ${result.isCorrect ? 'border-success bg-success-soft' : 'border-danger bg-danger-soft'}`}
        >
          <p className="flex items-center gap-2 text-label">
            {result.isCorrect ? (
              <CircleCheck aria-hidden="true" className="size-5 text-success" />
            ) : (
              <CircleX aria-hidden="true" className="size-5 text-danger" />
            )}
            {result.isCorrect ? r.correct : r.incorrect}
          </p>
          {!result.isCorrect && describe(item.question, result.correct) !== '' ? (
            <p>{formatMessage(r.correctAnswer, { answer: describe(item.question, result.correct) })}</p>
          ) : null}
          {result.explanation !== null && result.explanation !== undefined ? (
            <RichText doc={result.explanation} />
          ) : null}
        </div>
      ) : null}
      {error !== null ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {result === undefined ? (
          <Button
            variant="primary"
            disabled={busy || answers[item.id] === undefined}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const checked = await callApi<PracticeFeedback>(
                'PUT',
                `/api/v1/learn/practice/${attempt.id}/answers/${item.id}`,
                {
                  response: answers[item.id],
                },
              );
              setBusy(false);
              if (checked.ok) setFeedback({ ...feedback, [item.id]: checked.data });
              else setError(splitProblem(checked.problem, texts.common.networkError).summary);
            }}
          >
            {r.check}
          </Button>
        ) : null}
        {index < attempt.items.length - 1 ? (
          <Button variant={result === undefined ? 'ghost' : 'primary'} onClick={() => setIndex(index + 1)}>
            {r.next}
          </Button>
        ) : null}
        <Button
          variant={index === attempt.items.length - 1 && result !== undefined ? 'primary' : 'ghost'}
          onClick={async () => {
            const finished = await callApi<PracticeSummary>(
              'POST',
              `/api/v1/learn/practice/${attempt.id}/finish`,
            );
            if (finished.ok) setSummary(finished.data);
            else setError(splitProblem(finished.problem, texts.common.networkError).summary);
          }}
        >
          {r.finish}
        </Button>
      </div>
    </div>
  );
}
