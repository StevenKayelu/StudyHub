'use client';

import { formatMessage, type QuestionView, type QuizView } from '@studyhub/contracts';
import { Alert, Button, Card, StatusBadge } from '@studyhub/ui';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { type ApiResult, callApi, reloadTo, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';

const field = 'h-11 rounded-md border border-strong bg-surface px-3 font-normal';

/** datetime-local value (local time) ↔ ISO instant. */
const toLocalInput = (iso: string | null) => {
  if (iso === null) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => (value === '' ? null : new Date(value).toISOString());
const optionalInt = (value: FormDataEntryValue | null) =>
  value === null || String(value).trim() === '' ? null : Math.round(Number(value));

type Item = { questionId: string; pointsOverride: number | null };
type Rule = { count: number; tags: string[]; difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null };

/**
 * S-T06 Quiz builder: settings on one side, the questions (a fixed, ordered list from the bank, or
 * draw rules) on the other; the checklist decides when it can be made available (F18 AC 1).
 */
export function QuizBuilder({
  initial,
  bank,
  texts,
}: {
  initial: QuizView;
  bank: QuestionView[];
  texts: StudioTexts;
}) {
  const z = texts.studio.quizzes;
  const [quiz, setQuiz] = useState(initial);
  const [mode, setMode] = useState(initial.selectionMode);
  const [items, setItems] = useState<Item[]>(
    initial.items.map((i) => ({ questionId: i.questionId, pointsOverride: i.pointsOverride })),
  );
  const [rules, setRules] = useState<Rule[]>(
    initial.drawRules.map((r) => ({ count: r.count, tags: r.tags, difficulty: r.difficulty ?? null })),
  );
  const [picker, setPicker] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const stemOf = (questionId: string) =>
    bank.find((q) => q.id === questionId)?.stemText ??
    quiz.items.find((i) => i.questionId === questionId)?.stemText ??
    '';

  async function run(call: () => Promise<ApiResult<QuizView>>) {
    setBusy(true);
    setMessage(null);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      setQuiz(result.data);
      setMessage({ tone: 'success', text: texts.common.saved });
      return;
    }
    const split = splitProblem(result.problem, texts.common.networkError);
    setMessage({ tone: 'danger', text: split.summary ?? Object.values(split.fields).join(' ') });
  }

  const patch = (body: Record<string, unknown>) =>
    run(() =>
      callApi<QuizView>('PATCH', `/api/v1/studio/quizzes/${quiz.id}`, { version: quiz.version, ...body }),
    );

  const move = (index: number, by: number) => {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    setItems(next);
  };

  const available = bank.filter((q) => !items.some((i) => i.questionId === q.id));

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <Card className="flex flex-col gap-3 self-start">
        <h2 className="text-h3">{z.settings}</h2>
        <form
          method="post"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void patch({
              title: String(data.get('title') ?? '').trim(),
              timeLimitMinutes: optionalInt(data.get('timeLimit')),
              attemptsAllowed: optionalInt(data.get('attempts')),
              passMarkPercent: optionalInt(data.get('passMark')),
              shuffleQuestions: data.get('shuffleQuestions') === 'on',
              shuffleOptions: data.get('shuffleOptions') === 'on',
              opensAt: fromLocalInput(String(data.get('opensAt') ?? '')),
              closesAt: fromLocalInput(String(data.get('closesAt') ?? '')),
              feedbackPolicy: String(data.get('feedbackPolicy')),
              showCorrectAnswers: data.get('showCorrectAnswers') === 'on',
            });
          }}
        >
          <label className="flex flex-col gap-1 text-label">
            {z.quizTitle}
            <input name="title" required maxLength={120} defaultValue={quiz.title} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.timeLimit}
            <input
              name="timeLimit"
              inputMode="numeric"
              defaultValue={quiz.timeLimitMinutes ?? ''}
              className={field}
            />
            <span className="font-normal text-caption text-muted">{z.timeLimitHint}</span>
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.attemptsAllowed}
            <input
              name="attempts"
              inputMode="numeric"
              defaultValue={quiz.attemptsAllowed ?? ''}
              className={field}
            />
            <span className="font-normal text-caption text-muted">{z.attemptsHint}</span>
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.passMark}
            <input
              name="passMark"
              inputMode="numeric"
              defaultValue={quiz.passMarkPercent ?? ''}
              className={field}
            />
            <span className="font-normal text-caption text-muted">{z.passMarkHint}</span>
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.opensAt}
            <input
              type="datetime-local"
              name="opensAt"
              defaultValue={toLocalInput(quiz.opensAt)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.closesAt}
            <input
              type="datetime-local"
              name="closesAt"
              defaultValue={toLocalInput(quiz.closesAt)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {z.feedbackPolicy}
            <select name="feedbackPolicy" defaultValue={quiz.feedbackPolicy} className={field}>
              {(['IMMEDIATE', 'AFTER_CLOSE', 'NEVER'] as const).map((p) => (
                <option key={p} value={p}>
                  {texts.assessment.feedbackPolicies[p]}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ['showCorrectAnswers', z.showCorrectAnswers, quiz.showCorrectAnswers],
              ['shuffleQuestions', z.shuffleQuestions, quiz.shuffleQuestions],
              ['shuffleOptions', z.shuffleOptions, quiz.shuffleOptions],
            ] as const
          ).map(([name, label, checked]) => (
            <label key={name} className="flex min-h-11 items-center gap-2 text-body-sm">
              <input type="checkbox" name={name} defaultChecked={checked} className="size-5" />
              {label}
            </label>
          ))}
          <Button type="submit" variant="secondary" disabled={busy}>
            {z.saveSettings}
          </Button>
        </form>
      </Card>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={quiz.status === 'READY' ? 'published' : 'draft'}>
            {z.statuses[quiz.status]}
          </StatusBadge>
          <span className="text-body-sm text-muted" data-testid="quiz-total">
            {formatMessage(z.total, {
              points: formatMessage(texts.assessment.points, { count: quiz.totalPoints }),
              questions: formatMessage(texts.assessment.questions, { count: quiz.questionCount }),
            })}
          </span>
          <span className="flex-1" />
          {quiz.status === 'READY' ? (
            <Button variant="ghost" disabled={busy} onClick={() => void patch({ status: 'DRAFT' })}>
              {z.backToDraft}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || quiz.problems.length > 0}
              onClick={() => void patch({ status: 'READY' })}
            >
              {z.makeAvailable}
            </Button>
          )}
        </div>
        {message !== null ? (
          <Alert tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
            {message.text}
          </Alert>
        ) : null}
        {quiz.attemptCount > 0 ? (
          <Alert tone="warning">{formatMessage(z.attemptsWarning, { count: quiz.attemptCount })}</Alert>
        ) : null}
        {quiz.problems.length > 0 ? (
          <Alert tone="info" title={z.problems}>
            <ul className="list-disc ps-5">
              {quiz.problems.map((p) => (
                <li key={p.message}>{p.message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Card className="flex flex-col gap-3">
          <h2 className="text-h3">{z.questionsTitle}</h2>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">{z.mode}</legend>
            {(['FIXED', 'DRAW'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  className="size-5"
                />
                {value === 'FIXED' ? z.fixed : z.draw}
              </label>
            ))}
          </fieldset>

          {mode === 'FIXED' ? (
            <>
              <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
                {items.map((item, index) => {
                  const archived =
                    quiz.items.find((i) => i.questionId === item.questionId)?.archived === true;
                  return (
                    <li key={item.questionId} className="flex flex-wrap items-center gap-2 p-2">
                      <span className="tabular w-6 text-caption text-muted">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {stemOf(item.questionId)}
                        {archived ? (
                          <span className="block text-caption text-warning">{z.archivedQuestion}</span>
                        ) : null}
                      </span>
                      <label className="flex items-center gap-1 text-caption">
                        {z.pointsOverride}
                        <input
                          inputMode="decimal"
                          className={`${field} w-20`}
                          value={item.pointsOverride ?? ''}
                          placeholder={String(bank.find((q) => q.id === item.questionId)?.points ?? '')}
                          onChange={(event) =>
                            setItems(
                              items.map((i, n) =>
                                n === index
                                  ? {
                                      ...i,
                                      pointsOverride:
                                        event.target.value === '' ? null : Number(event.target.value),
                                    }
                                  : i,
                              ),
                            )
                          }
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={texts.common.moveUp}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        icon={<ArrowUp aria-hidden="true" className="size-4" />}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={texts.common.moveDown}
                        disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                        icon={<ArrowDown aria-hidden="true" className="size-4" />}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={z.removeQuestion}
                        onClick={() => setItems(items.filter((_, n) => n !== index))}
                        icon={<Trash2 aria-hidden="true" className="size-4" />}
                      />
                    </li>
                  );
                })}
              </ol>
              {available.length === 0 ? (
                <p className="text-body-sm text-muted">{z.pickerEmpty}</p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-label">
                    {z.pickerTitle}
                    <select
                      className={field}
                      value={picker}
                      onChange={(event) => setPicker(event.target.value)}
                    >
                      <option value="">—</option>
                      {available.map((q) => (
                        <option key={q.id} value={q.id}>
                          {`${q.stemText.slice(0, 80)} (${texts.assessment.questionTypes[q.type]})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    disabled={picker === ''}
                    onClick={() => {
                      setItems([...items, { questionId: picker, pointsOverride: null }]);
                      setPicker('');
                    }}
                  >
                    {z.addQuestion}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              {rules.map((rule, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2 rounded-md border border-line p-2">
                  <label className="flex flex-col gap-1 text-label">
                    {z.drawCount}
                    <input
                      inputMode="numeric"
                      className={`${field} w-20`}
                      value={rule.count}
                      onChange={(event) =>
                        setRules(
                          rules.map((r, n) =>
                            n === index ? { ...r, count: Number(event.target.value) || 1 } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-label">
                    {z.drawTags}
                    <input
                      className={field}
                      value={rule.tags.join(', ')}
                      onChange={(event) =>
                        setRules(
                          rules.map((r, n) =>
                            n === index
                              ? {
                                  ...r,
                                  tags: event.target.value
                                    .split(',')
                                    .map((t) => t.trim().toLowerCase())
                                    .filter(Boolean),
                                }
                              : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-label">
                    {texts.studio.questions.difficulty}
                    <select
                      className={field}
                      value={rule.difficulty ?? ''}
                      onChange={(event) =>
                        setRules(
                          rules.map((r, n) =>
                            n === index
                              ? { ...r, difficulty: (event.target.value || null) as Rule['difficulty'] }
                              : r,
                          ),
                        )
                      }
                    >
                      <option value="">{texts.studio.questions.anyDifficulty}</option>
                      {(['EASY', 'MEDIUM', 'HARD'] as const).map((d) => (
                        <option key={d} value={d}>
                          {texts.assessment.difficulties[d]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="pb-3 text-caption text-muted">
                    {quiz.drawRules[index] !== undefined
                      ? formatMessage(z.drawAvailable, { count: quiz.drawRules[index]!.available })
                      : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={texts.common.remove}
                    onClick={() => setRules(rules.filter((_, n) => n !== index))}
                    icon={<Trash2 aria-hidden="true" className="size-4" />}
                  />
                </div>
              ))}
              <Button
                variant="ghost"
                className="self-start"
                onClick={() => setRules([...rules, { count: 5, tags: [], difficulty: null }])}
              >
                {z.addDrawRule}
              </Button>
            </div>
          )}
          <Button
            variant="primary"
            className="self-start"
            disabled={busy}
            onClick={() =>
              void run(() =>
                callApi<QuizView>('PUT', `/api/v1/studio/quizzes/${quiz.id}/items`, {
                  version: quiz.version,
                  selectionMode: mode,
                  items,
                  drawRules: rules.map((r) => ({ ...r, types: [] })),
                }),
              )
            }
          >
            {z.saveQuestions}
          </Button>
        </Card>

        {quiz.attemptCount === 0 ? (
          <Button
            variant="ghost"
            className="self-start"
            onClick={async () => {
              if (!window.confirm(fill(z.deleteConfirm, { title: quiz.title }))) return;
              const result = await callApi('DELETE', `/api/v1/studio/quizzes/${quiz.id}`);
              if (result.ok) reloadTo(`/studio/courses/${quiz.courseId}/quizzes`);
            }}
          >
            {z.delete}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
