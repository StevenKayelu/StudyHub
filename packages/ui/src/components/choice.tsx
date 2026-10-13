'use client';

import { Check } from 'lucide-react';
import { Checkbox as RadixCheckbox, RadioGroup as RadixRadioGroup, Switch as RadixSwitch } from 'radix-ui';
import { type ReactNode, useId } from 'react';

import { cx } from './cx.js';

/** The whole row (control + label) is the hit area, at least 44 px tall (06 §2.5). */
const rowClasses = 'flex min-h-11 cursor-pointer items-center gap-3 text-body text-ink';

export interface CheckboxProps {
  label: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
}

export function Checkbox({ label, hint, id: idProp, onCheckedChange, ...rest }: CheckboxProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div>
      <label htmlFor={id} className={rowClasses}>
        <RadixCheckbox.Root
          id={id}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          onCheckedChange={(value) => onCheckedChange?.(value === true)}
          className={cx(
            'flex size-5 shrink-0 items-center justify-center rounded-sm border border-strong bg-surface',
            'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent',
            'disabled:bg-sunken',
          )}
          {...rest}
        >
          <RadixCheckbox.Indicator>
            <Check aria-hidden="true" className="size-4" strokeWidth={2.5} />
          </RadixCheckbox.Indicator>
        </RadixCheckbox.Root>
        <span>{label}</span>
      </label>
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="ms-8 text-body-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: ReactNode;
  options: RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
}

export function RadioGroup({ legend, options, ...rest }: RadioGroupProps) {
  const base = useId();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-label text-ink">{legend}</legend>
      <RadixRadioGroup.Root className="flex flex-col" {...rest}>
        {options.map((option) => {
          const id = `${base}-${option.value}`;
          return (
            <label key={option.value} htmlFor={id} className={rowClasses}>
              <RadixRadioGroup.Item
                id={id}
                value={option.value}
                disabled={option.disabled}
                className={cx(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border border-strong bg-surface',
                  'data-[state=checked]:border-accent',
                )}
              >
                <RadixRadioGroup.Indicator className="size-2.5 rounded-full bg-accent" />
              </RadixRadioGroup.Item>
              <span>{option.label}</span>
            </label>
          );
        })}
      </RadixRadioGroup.Root>
    </fieldset>
  );
}

export interface SwitchProps {
  label: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
}

export function Switch({ label, description, id: idProp, ...rest }: SwitchProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-body text-ink">
          {label}
        </label>
        {description !== undefined ? (
          <p id={`${id}-description`} className="text-body-sm text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <RadixSwitch.Root
        id={id}
        aria-describedby={description !== undefined ? `${id}-description` : undefined}
        className={cx(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-strong bg-sunken',
          'transition-colors duration-fast data-[state=checked]:border-accent data-[state=checked]:bg-accent',
          'disabled:cursor-not-allowed',
        )}
        {...rest}
      >
        <RadixSwitch.Thumb
          className={cx(
            'block size-5 translate-x-1 rounded-full bg-strong transition-transform duration-fast',
            'data-[state=checked]:translate-x-6 data-[state=checked]:bg-on-accent',
          )}
        />
      </RadixSwitch.Root>
    </div>
  );
}
