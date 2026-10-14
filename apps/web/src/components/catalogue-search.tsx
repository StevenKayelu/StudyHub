import { buttonClasses } from '@studyhub/ui';
import { Search } from 'lucide-react';

/** Search field that works without JavaScript: a GET form to /browse (S-P01, S-P02). */
export function CatalogueSearch({
  label,
  placeholder,
  submitLabel,
  defaultValue,
  hidden = {},
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  defaultValue?: string | undefined;
  /** Filters kept when searching again from /browse. */
  hidden?: Record<string, string>;
}) {
  return (
    <form action="/browse" method="get" role="search" className="flex w-full max-w-reading flex-col gap-2">
      <label htmlFor="catalogue-q" className="text-label text-ink">
        {label}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted"
          />
          <input
            id="catalogue-q"
            name="q"
            type="search"
            maxLength={100}
            defaultValue={defaultValue}
            placeholder={placeholder}
            className="h-11 w-full rounded-md border border-line-strong bg-surface ps-10 pe-3 text-body text-ink placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </div>
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <button type="submit" className={buttonClasses('primary', 'md')}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
