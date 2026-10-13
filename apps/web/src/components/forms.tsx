'use client';

import { Alert, ErrorSummary } from '@studyhub/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { type ApiResult, splitProblem } from '../lib/client-api';

export interface FormTexts {
  errorSummary: string;
  networkError: string;
}

/**
 * Form state for an API-backed form (06 §2.7): busy flag, per-field errors from problem+json, and a
 * summary for everything else. On a failed submit, focus moves to the summary.
 */
export function useApiForm(texts: FormTexts) {
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (focusTick > 0) summaryRef.current?.focus();
  }, [focusTick]);

  async function submit<T>(
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<ApiResult<T>>,
  ): Promise<T | null> {
    event.preventDefault();
    if (busy) return null;
    setBusy(true);
    setSummary(null);
    setFields({});
    try {
      const result = await run(new FormData(event.currentTarget));
      if (result.ok) return result.data;
      const split = splitProblem(result.problem, texts.networkError);
      setFields(split.fields);
      setSummary(split.summary);
      setFocusTick((tick) => tick + 1);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (name: string) => fields[name];

  const feedback =
    Object.keys(fields).length > 0 ? (
      <ErrorSummary
        ref={summaryRef}
        title={texts.errorSummary}
        errors={Object.entries(fields).map(([field, message]) => ({ fieldId: field, message }))}
      />
    ) : summary !== null ? (
      <div ref={summaryRef} tabIndex={-1}>
        <Alert tone="danger" role="alert" title={summary} />
      </div>
    ) : null;

  return { busy, submit, fieldError, feedback, setSummary };
}

/** A string field from FormData (empty string when missing). */
export const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
};
