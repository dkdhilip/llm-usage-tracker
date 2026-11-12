import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { pageContainer } from "../../lib/portal";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./icons";

export interface ComboOption {
  value: string;
  label: string;
  /** A short note at the end of the row (a key's status). */
  hint?: string;
}

/** The look of a field-sized trigger (shared with the key picker). */
export const COMBO_TRIGGER =
  "inline-flex h-8 min-w-[9rem] items-center justify-between gap-2 rounded-md border border-control bg-surface px-2.5 text-sm text-fg " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-text disabled:cursor-not-allowed disabled:opacity-60";

export const COMBO_ITEM =
  "flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm text-fg aria-selected:bg-fill data-[disabled=true]:opacity-50";

/** A single-choice list in a popover, in the app's own style (not the browser's native dropdown, which looks different
 *  in every browser). Type to filter, Arrow keys move, Enter chooses, Escape closes and returns focus to the button.
 *  The button is named "<label>: <current choice>", so its name contains the text a sighted user reads on it.
 *  `searchable` (the default) shows a search box, for a long list such as 97 models; `searchable={false}` is for a
 *  short list (a provider, a status): no box is drawn, but typing still jumps to a matching row. */
export function Combobox({
  label,
  value,
  onChange,
  options,
  allLabel,
  searchPlaceholder,
  searchable = true,
  disabled,
  className,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  /** The "no filter" row (value ""), for example "All models". */
  allLabel?: string;
  searchPlaceholder?: string;
  /** Show the search box (default). Off for a short list. */
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
  /** Extra content above the list (the key picker puts its status filter here). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);
  const shown = current ? current.label : (allLabel ?? "");
  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-controls={listId} aria-label={`${label}: ${shown}`} disabled={disabled} className={cn(COMBO_TRIGGER, className)}>
          <span className="truncate">{shown}</span>
          <ChevronDownIcon className="shrink-0 text-fg-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={pageContainer()}>
        <Popover.Content align="start" sideOffset={4} onOpenAutoFocus={(e) => { e.preventDefault(); search.current?.focus(); }} className={cn("z-50 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface-raised p-1.5 shadow-lg focus:outline-none", searchable ? "w-72" : "w-56")}>
          {children}
          <Command label={`Search ${label.toLowerCase()}`} className="flex flex-col">
            {searchable ? (
              <div className="mb-1 flex items-center gap-2 border-b border-line px-2">
                <SearchIcon className="shrink-0 text-fg-subtle" />
                <Command.Input ref={search} placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`} className="h-9 w-full bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none" />
              </div>
            ) : (
              // still in the page (and focused) so the arrow keys and typing work, but not drawn
              <Command.Input ref={search} aria-label={`Choose ${label.toLowerCase()}`} className="sr-only" />
            )}
            <Command.List id={listId} className="max-h-64 overflow-y-auto">
              <Command.Empty className="px-2 py-3 text-sm text-fg-muted">No match</Command.Empty>
              {allLabel && (
                <Command.Item value={allLabel} onSelect={() => choose("")} className={COMBO_ITEM}>
                  <span>{allLabel}</span>
                  {value === "" && <CheckIcon className="text-brand-text" />}
                </Command.Item>
              )}
              {options.map((o) => (
                <Command.Item key={o.value} value={`${o.label} ${o.value}`} onSelect={() => choose(o.value)} className={COMBO_ITEM}>
                  <span className="truncate">{o.label}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {o.hint && <span className="text-xs capitalize text-fg-muted">{o.hint}</span>}
                    {o.value === value && <CheckIcon className="text-brand-text" />}
                  </span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
