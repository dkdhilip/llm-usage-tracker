import { KEY_STATUSES, toggleStatus, type KeyStatus } from "../lib/keyOptions";

/** Three tick boxes (Active, Revoked, Deleted) that choose which keys a list shows. */
export function KeyStatusFilter({
  value,
  onChange,
  label = "Key status",
}: {
  value: KeyStatus[];
  onChange: (v: KeyStatus[]) => void;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
      {KEY_STATUSES.map((s) => (
        <label key={s.id} className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.includes(s.id)}
            onChange={() => onChange(toggleStatus(value, s.id))}
            className="h-3.5 w-3.5 accent-brand-600"
          />
          {s.label}
        </label>
      ))}
    </div>
  );
}
