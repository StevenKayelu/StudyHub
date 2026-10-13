'use client';

import { Check, ChevronDown } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';
import { type ReactNode, useId } from 'react';

import { cx } from './cx.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: ReactNode;
  options: SelectOption[];
  placeholder?: string;
  hint?: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
}

/** For fewer than 10 options (06 §2.5). Larger lists use a searchable combobox (later milestones). */
export function Select({ label, options, placeholder, hint, id: idProp, ...rest }: SelectProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <RadixSelect.Root {...rest}>
        <RadixSelect.Trigger
          id={id}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          className={cx(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-sm border border-strong bg-surface px-3',
            'text-start text-body text-ink data-[placeholder]:text-subtle disabled:bg-sunken disabled:text-subtle',
          )}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon>
            <ChevronDown aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="z-[40] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface shadow-1"
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cx(
                    'flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-sm px-3 text-body text-ink outline-none',
                    'data-[highlighted]:bg-accent-soft data-[disabled]:text-subtle',
                  )}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator>
                    <Check aria-hidden="true" className="size-4 text-accent" strokeWidth={2} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-body-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
