'use client';

import { type AnswerResponse, type AttemptView, formatMessage } from '@studyhub/contracts';
import { useId } from 'react';

import type { LearnTexts } from '../lib/learn-texts-type';
import { RichText } from './rich-text';

type Question = AttemptView['items'][number]['question'];

const LETTERS = 'ABCDEFGHIJ';

/**
 * One question and its answer area (S-L05): choice cards as a radio or checkbox group with letters,
 * a text input, a number input with its unit, or a long-answer box with a word count. The question
 * is the page's h2 (06 S-L05 a11y).
 */
export function QuestionInput({
  question,
  value,
  onChange,
  texts,
  disabled = false,
  heading,
}: {
  question: Question;
  value: AnswerResponse | null;
  onChange: (response: AnswerResponse) => void;
  texts: LearnTexts;
  disabled?: boolean;
  heading: string;
}) {
  const id = useId();
  const r = texts.runner;
  const chosen = value !== null && 'optionIds' in value ? value.optionIds : [];
  const multiple = question.type === 'MULTIPLE_CHOICE';

  return (
    <div className="flex flex-col gap-4">
      <h2 id={`${id}-q`} className="sr-only">
        {heading}
      </h2>
      <div className="font-reading text-body-lg">
        <RichText doc={question.stem} />
      </div>

      {question.type === 'SINGLE_CHOICE' || question.type === 'TRUE_FALSE' || multiple ? (
        <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint`}>
          <legend className="sr-only">{heading}</legend>
          <p id={`${id}-hint`} className="text-caption text-muted">
            {multiple ? r.choiceMany : r.choiceOne}
          </p>
          {question.options.map((option, index) => {
            const checked = chosen.includes(option.id);
            return (
              <label
                key={option.id}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border p-3 ${
                  checked ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'
                }`}
              >
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={`${id}-choice`}
                  value={option.id}
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => {
                    if (!multiple) onChange({ optionIds: [option.id] });
                    else {
                      const next = event.target.checked
                        ? [...chosen, option.id]
                        : chosen.filter((existing) => existing !== option.id);
                      onChange({ optionIds: next });
                    }
                  }}
                  className="size-5 shrink-0 accent-[var(--color-accent)]"
                />
                <span aria-hidden="true" className="tabular text-label text-muted">
                  {LETTERS[index]}
                </span>
                <span>{option.content}</span>
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {question.type === 'SHORT_ANSWER' ? (
        <label className="flex flex-col gap-1 text-label">
          {r.answerPlaceholder}
          <input
            value={value !== null && 'text' in value ? value.text : ''}
            maxLength={500}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onChange({ text: event.target.value })}
            className="h-12 rounded-md border border-strong bg-surface px-3 font-normal"
          />
        </label>
      ) : null}

      {question.type === 'NUMERIC' ? (
        <label className="flex flex-col gap-1 text-label">
          {r.answerPlaceholder}
          <span className="flex items-center gap-2">
            <input
              inputMode="decimal"
              defaultValue={value !== null && 'number' in value ? String(value.number) : ''}
              disabled={disabled}
              aria-describedby={`${id}-number-hint`}
              onChange={(event) => {
                const parsed = Number(event.target.value.replace(',', '.'));
                if (event.target.value.trim() !== '' && Number.isFinite(parsed)) onChange({ number: parsed });
              }}
              className="h-12 w-48 rounded-md border border-strong bg-surface px-3 font-normal"
            />
            {question.unit !== undefined ? <span className="font-normal">{question.unit}</span> : null}
          </span>
          <span id={`${id}-number-hint`} className="font-normal text-caption text-muted">
            {r.numberHint}
          </span>
        </label>
      ) : null}

      {question.type === 'LONG_ANSWER' ? (
        <label className="flex flex-col gap-1 text-label">
          {r.answerPlaceholder}
          <textarea
            value={value !== null && 'text' in value ? value.text : ''}
            rows={10}
            maxLength={20_000}
            disabled={disabled}
            onChange={(event) => onChange({ text: event.target.value })}
            className="rounded-md border border-strong bg-surface p-3 font-normal"
          />
          <span className="font-normal text-caption text-muted">
            {formatMessage(r.words, {
              count:
                value !== null && 'text' in value ? value.text.trim().split(/\s+/).filter(Boolean).length : 0,
            })}
          </span>
        </label>
      ) : null}
    </div>
  );
}
