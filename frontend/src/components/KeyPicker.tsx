import { useEffect, useRef, useState } from "react";
import { DEFAULT_KEY_STATUSES, type KeyOption, type KeyStatus } from "../lib/keyOptions";
import { KeyStatusFilter } from "./KeyStatusFilter";

/** The "All keys" dropdown: tick which keys to list (Active by default), then pick one. The picked key stays
 *  listed even if its status is later unticked, so the current choice never disappears. */
export function KeyPicker({
  keys,
  value,
  onChange,
  className,
}: {
  keys: KeyOption[];
  value: string;
  onChange: (keyId: string) => void;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<KeyStatus[]>(DEFAULT_KEY_STATUSES);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const picked = keys.find((k) => String(k.key_id) === value);
  const shown = keys.filter((k) => statuses.includes(k.status) || String(k.key_id) === value);
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const row = (selected: boolean) =>
    `flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-fill ${selected ? "font-medium text-brand-600" : "text-fg"}`;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Key"
        onClick={() => setOpen((o) => !o)}
        className={`${className} flex min-w-[9rem] items-center justify-between gap-2 text-left`}
      >
        <span className="truncate">{picked ? picked.label : "All keys"}</span>
        <span aria-hidden className="text-xs text-fg-subtle">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 rounded-md border border-line bg-surface p-2 shadow-lg">
          <div className="border-b border-line pb-2">
            <KeyStatusFilter value={statuses} onChange={setStatuses} />
          </div>
          <ul role="listbox" aria-label="Keys" className="mt-1 max-h-64 overflow-y-auto text-sm">
            <li role="option" aria-selected={value === ""}>
              <button type="button" onClick={() => choose("")} className={row(value === "")}>
                All keys
              </button>
            </li>
            {shown.map((k) => (
              <li key={k.key_id} role="option" aria-selected={String(k.key_id) === value}>
                <button type="button" onClick={() => choose(String(k.key_id))} className={row(String(k.key_id) === value)}>
                  <span className="truncate">{k.label}</span>
                  {k.status !== "active" && <span className="text-xs capitalize text-fg-subtle">{k.status}</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2 py-1.5 text-fg-subtle">No keys with these statuses</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
