'use client';

import { CircleAlert } from 'lucide-react';
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

import { cx } from './cx.js';

interface FieldFrameProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  required?: boolean | undefined;
  requiredLabel?: string | undefined;
  children: ReactNode;
}

/** Label above, hint and error below, linked with aria-describedby (06 §2.5, §2.7). */
function FieldFrame({ id, label, hint, error, required, requiredLabel, children }: FieldFrameProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
        {required === true && requiredLabel !== undefined ? (
          <span className="font-normal text-muted"> ({requiredLabel})</span>
        ) : null}
      </label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-body-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={`${id}-error`} className="flex items-start gap-1 text-body-sm text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

const controlClasses = cx(
  'w-full rounded-sm border border-strong bg-surface px-3 text-body text-ink',
  'aria-[invalid=true]:border-danger disabled:bg-sunken disabled:text-subtle',
);

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint !== undefined ? `${id}-hint` : null, error !== undefined ? `${id}-error` : null].filter(
    (value): value is string => value !== null,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Text shown after the label of required fields, e.g. "required". */
  requiredLabel?: string;
  id?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, requiredLabel, id: idProp, className, required, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      requiredLabel={requiredLabel}
    >
      <input
        ref={ref}
        id={id}
        required={required}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cx(controlClasses, 'min-h-11', className)}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  requiredLabel?: string;
  id?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, requiredLabel, id: idProp, className, required, rows = 4, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      requiredLabel={requiredLabel}
    >
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cx(controlClasses, 'py-2', className)}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface ErrorSummaryProps {
  title: ReactNode;
  errors: { fieldId: string; message: ReactNode }[];
}

/** Form-level error list; each entry links to its field. Focus it after a failed submit (06 §2.7). */
export const ErrorSummary = forwardRef<HTMLDivElement, ErrorSummaryProps>(function ErrorSummary(
  { title, errors },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-danger bg-danger-soft p-4 text-ink"
    >
      <p className="text-label text-danger">{title}</p>
      <ul className="mt-2 list-disc ps-5">
        {errors.map((error) => (
          <li key={error.fieldId}>
            <a href={`#${error.fieldId}`} className="text-danger underline">
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
});
