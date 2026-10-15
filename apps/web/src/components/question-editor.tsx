'use client';

import type { QuestionType, QuestionView } from '@studyhub/contracts';
import { Alert, Button, ErrorSummary, Switch } from '@studyhub/ui';
import type { JSONContent } from '@tiptap/react';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { callApi, reloadTo, splitProblem } from '../lib/client-api';
import { fill } from '../lib/fill';
import type { StudioTexts } from '../lib/studio-texts-type';
import { RichTextEditor } from './rich-text-editor';

const TYPES: QuestionType[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'NUMERIC',
  'LONG_ANSWER',
];
const field = 'h-11 rounded-md border border-strong bg-surface px-3 font-normal';

type Option = { content: string; isCorrect: boolean };

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

function defaultOptions(type: QuestionType, texts: StudioTexts): Option[] {
  if (type === 'TRUE_FALSE') {
    return [
      { content: texts.assessment.true, isCorrect: true },
      { content: texts.assessment.false, isCorrect: false },
    ];
  }
  return [
    { content: '', isCorrect: true },
    { content: '', isCorrect: false },
  ];
}

/**
 * S-T05 question editor: type → question → answers (options, accepted answers or a number) → points,
 * difficulty, tags, explanation. The API validates (F17 AC 1) and its messages appear inline.
 */
export function QuestionEditor({
  courseId,
  initial,
  texts,
}: {
  courseId: string;
  initial: QuestionView | null;
  texts: StudioTexts;
}) {
  const q = texts.studio.questions;
  const id = useId();
  const [type, setType] = useState<QuestionType>(initial?.type ?? 'SINGLE_CHOICE');
  const [options, setOptions] = useState<Option[]>(
    initial?.options.map((o) => ({ content: o.content, isCorrect: o.isCorrect })) ??
      defaultOptions('SINGLE_CHOICE', texts),
  );
  const [partialCredit, setPartialCredit] = useState(initial?.settings.partialCredit === true);
  const [practice, setPractice] = useState(initial?.practiceEligible ?? true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ fields: Record<string, string>; summary: string | null }>({
    fields: {},
    summary: null,
  });
  const stem = useRef<JSONContent | unknown>(initial?.stem ?? emptyDoc);
  const explanation = useRef<JSONContent | unknown>(initial?.explanation ?? null);
  const base = `/studio/courses/${courseId}/questions`;
  const choice = type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE';

  async function save(form: HTMLFormElement, next: 'list' | 'new') {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const number = (name: string) => (text(name) === '' ? undefined : Number(text(name)));
    const body = {
      ...(initial === null ? { type } : { version: initial.version }),
      stem: stem.current,
      explanation: explanation.current,
      points: number('points') ?? 1,
      difficulty: text('difficulty') || 'MEDIUM',
      tags: text('tags')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      practiceEligible: type === 'LONG_ANSWER' ? false : practice,
      settings: {
        ...(type === 'MULTIPLE_CHOICE' && { partialCredit }),
        ...(type === 'SHORT_ANSWER' && {
          acceptedAnswers: text('acceptedAnswers')
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean),
          caseSensitive: data.get('caseSensitive') === 'on',
        }),
        ...(type === 'NUMERIC' && {
          value: number('value'),
          tolerance: number('tolerance') ?? 0,
          unit: text('unit'),
        }),
      },
      options: choice || type === 'TRUE_FALSE' ? options : [],
    };
    setBusy(true);
    setErrors({ fields: {}, summary: null });
    const result =
      initial === null
        ? await callApi<QuestionView>('POST', `/api/v1/studio/courses/${courseId}/questions`, body)
        : await callApi<QuestionView>('PATCH', `/api/v1/studio/questions/${initial.id}`, body);
    setBusy(false);
    if (result.ok) {
      reloadTo(next === 'new' ? `${base}/new` : base);
      return;
    }
    setErrors(splitProblem(result.problem, texts.common.networkError));
  }

  const fieldError = (name: string) =>
    errors.fields[name] !== undefined ? (
      <span className="text-body-sm text-danger" id={`${id}-${name}-error`}>
        {errors.fields[name]}
      </span>
    ) : null;

  return (
    <form
      method="post"
      className="flex max-w-reading flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void save(event.currentTarget, submitter?.value === 'new' ? 'new' : 'list');
      }}
    >
      {errors.summary !== null || Object.keys(errors.fields).length > 0 ? (
        <ErrorSummary
          title={texts.common.errorSummary}
          errors={
            errors.summary !== null
              ? [{ fieldId: `${id}-stem`, message: errors.summary }]
              : Object.entries(errors.fields).map(([name, message]) => ({
                  fieldId: `${id}-${name.split('.')[0]}`,
                  message,
                }))
          }
        />
      ) : null}
      {initial !== null && initial.usedInQuizzes > 0 ? <Alert tone="info">{q.editWarning}</Alert> : null}

      <label className="flex flex-col gap-1 text-label">
        {q.type}
        <select
          className={field}
          value={type}
          disabled={initial !== null}
          onChange={(event) => {
            const next = event.target.value as QuestionType;
            setType(next);
            setOptions(defaultOptions(next, texts));
          }}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {texts.assessment.questionTypes[t]}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span id={`${id}-stem-label`} className="text-label">
          {q.stem}
        </span>
        <RichTextEditor
          id={`${id}-stem`}
          labelledBy={`${id}-stem-label`}
          initial={initial?.stem ?? null}
          onChange={(doc) => (stem.current = doc)}
          texts={texts.studio.editor}
          invalid={errors.fields.stem !== undefined}
        />
        {fieldError('stem')}
      </div>

      {choice ? (
        <fieldset className="flex flex-col gap-2" id={`${id}-options`}>
          <legend className="text-label">{q.options}</legend>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <label className="flex min-h-11 items-center gap-2 text-body-sm">
                <input
                  type={type === 'SINGLE_CHOICE' ? 'radio' : 'checkbox'}
                  name={`${id}-correct`}
                  checked={option.isCorrect}
                  onChange={(event) =>
                    setOptions(
                      options.map((o, i) =>
                        type === 'SINGLE_CHOICE'
                          ? { ...o, isCorrect: i === index }
                          : i === index
                            ? { ...o, isCorrect: event.target.checked }
                            : o,
                      ),
                    )
                  }
                  className="size-5 accent-[var(--color-accent)]"
                />
                <span className="sr-only">{fill(q.option, { number: index + 1 })}: </span>
                {q.correct}
              </label>
              <input
                aria-label={fill(q.option, { number: index + 1 })}
                value={option.content}
                maxLength={500}
                onChange={(event) =>
                  setOptions(options.map((o, i) => (i === index ? { ...o, content: event.target.value } : o)))
                }
                className={`${field} flex-1`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={fill(q.removeOption, { number: index + 1 })}
                disabled={options.length <= 2}
                onClick={() => setOptions(options.filter((_, i) => i !== index))}
                icon={<Trash2 aria-hidden="true" className="size-4" />}
              />
            </div>
          ))}
          {fieldError('options')}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={options.length >= 10}
            onClick={() => setOptions([...options, { content: '', isCorrect: false }])}
            icon={<Plus aria-hidden="true" className="size-4" />}
          >
            {q.addOption}
          </Button>
          {type === 'MULTIPLE_CHOICE' ? (
            <Switch
              label={q.partialCredit}
              description={q.partialCreditHint}
              checked={partialCredit}
              onCheckedChange={setPartialCredit}
            />
          ) : null}
        </fieldset>
      ) : null}

      {type === 'TRUE_FALSE' ? (
        <fieldset className="flex flex-col gap-2" id={`${id}-options`}>
          <legend className="text-label">{q.statementIs}</legend>
          {[true, false].map((value) => (
            <label key={String(value)} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`${id}-tf`}
                checked={options[0]?.isCorrect === value}
                onChange={() =>
                  setOptions([
                    { content: texts.assessment.true, isCorrect: value },
                    { content: texts.assessment.false, isCorrect: !value },
                  ])
                }
                className="size-5 accent-[var(--color-accent)]"
              />
              {value ? texts.assessment.true : texts.assessment.false}
            </label>
          ))}
          {fieldError('options')}
        </fieldset>
      ) : null}

      {type === 'SHORT_ANSWER' ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-label" htmlFor={`${id}-settings`}>
            {q.acceptedAnswers}
            <span className="font-normal text-muted">{q.acceptedAnswersHint}</span>
          </label>
          <textarea
            id={`${id}-settings`}
            name="acceptedAnswers"
            rows={3}
            defaultValue={(initial?.settings.acceptedAnswers ?? []).join('\n')}
            className="rounded-md border border-strong bg-surface p-3"
          />
          {fieldError('settings.acceptedAnswers')}
          <label className="flex min-h-11 items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              name="caseSensitive"
              defaultChecked={initial?.settings.caseSensitive === true}
              className="size-5"
            />
            {q.caseSensitive}
          </label>
        </div>
      ) : null}

      {type === 'NUMERIC' ? (
        <div className="grid gap-3 sm:grid-cols-3" id={`${id}-settings`}>
          <label className="flex flex-col gap-1 text-label">
            {q.value}
            <input
              name="value"
              inputMode="decimal"
              defaultValue={initial?.settings.value ?? ''}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {q.tolerance}
            <input
              name="tolerance"
              inputMode="decimal"
              defaultValue={initial?.settings.tolerance ?? 0}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {q.unit}
            <input name="unit" maxLength={20} defaultValue={initial?.settings.unit ?? ''} className={field} />
          </label>
          <div className="sm:col-span-3">{fieldError('settings.value')}</div>
        </div>
      ) : null}

      {type === 'LONG_ANSWER' ? <p className="text-body-sm text-muted">{q.longAnswerHint}</p> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-label">
          {q.points}
          <input
            name="points"
            inputMode="decimal"
            defaultValue={initial?.points ?? 1}
            className={field}
            id={`${id}-points`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {q.difficulty}
          <select name="difficulty" defaultValue={initial?.difficulty ?? 'MEDIUM'} className={field}>
            {(['EASY', 'MEDIUM', 'HARD'] as const).map((d) => (
              <option key={d} value={d}>
                {texts.assessment.difficulties[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label">
          {q.tags}
          <input
            name="tags"
            defaultValue={initial?.tags.join(', ') ?? ''}
            placeholder={q.tagsHint}
            className={field}
            id={`${id}-tags`}
          />
        </label>
      </div>
      {fieldError('points')}

      <div className="flex flex-col gap-1">
        <span id={`${id}-explanation-label`} className="text-label">
          {q.explanation}
        </span>
        <span id={`${id}-explanation-hint`} className="text-body-sm text-muted">
          {q.explanationHint}
        </span>
        <RichTextEditor
          id={`${id}-explanation`}
          labelledBy={`${id}-explanation-label`}
          describedBy={`${id}-explanation-hint`}
          initial={initial?.explanation ?? null}
          onChange={(doc) => (explanation.current = doc)}
          texts={texts.studio.editor}
        />
      </div>

      {type !== 'LONG_ANSWER' ? (
        <Switch label={q.practiceEligible} checked={practice} onCheckedChange={setPractice} />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" value="list" disabled={busy}>
          {q.save}
        </Button>
        {initial === null ? (
          <Button type="submit" variant="secondary" value="new" disabled={busy}>
            {q.saveAndNew}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                const result = await callApi<QuestionView>(
                  'POST',
                  `/api/v1/studio/questions/${initial.id}/duplicate`,
                );
                if (result.ok) reloadTo(`${base}/${result.data.id}`);
              }}
            >
              {q.duplicate}
            </Button>
            {initial.status === 'ACTIVE' ? (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  const result = await callApi('DELETE', `/api/v1/studio/questions/${initial.id}`);
                  if (result.ok) reloadTo(base);
                }}
              >
                {q.archive}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </form>
  );
}
