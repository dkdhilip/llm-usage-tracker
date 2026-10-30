import { cn } from "../../lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** A single-choice toggle group (time range, metric). Each option is a button that exposes its state with
 *  aria-pressed; the group is named, so a screen reader says what is being chosen. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex overflow-hidden rounded-md border border-control", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-8 min-w-9 border-l border-line px-3 text-ui font-medium first:border-l-0",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text",
              on ? "bg-brand-600 text-white" : "bg-surface text-fg-muted hover:bg-fill hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
