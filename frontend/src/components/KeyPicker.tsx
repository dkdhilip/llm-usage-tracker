import { useState } from "react";
import { DEFAULT_KEY_STATUSES, type KeyOption, type KeyStatus } from "../lib/keyOptions";
import { KeyStatusFilter } from "./KeyStatusFilter";
import { Combobox } from "./ui/Combobox";

/** The "All keys" picker: tick which keys to list (Active by default), then search and pick one. The picked key stays
 *  listed even if its status is later unticked, so the current choice never disappears. It is the same searchable
 *  combobox as the model filter: type to filter, Arrow keys to move, Enter to choose, Escape to close. */
export function KeyPicker({
  keys,
  value,
  onChange,
  className,
}: {
  keys: KeyOption[];
  value: string;
  onChange: (keyId: string) => void;
  className?: string;
}) {
  const [statuses, setStatuses] = useState<KeyStatus[]>(DEFAULT_KEY_STATUSES);
  const options = keys
    .filter((k) => statuses.includes(k.status) || String(k.key_id) === value)
    .map((k) => ({ value: String(k.key_id), label: k.label, hint: k.status !== "active" ? k.status : undefined }));
  return (
    <Combobox label="Key" value={value} onChange={onChange} options={options} allLabel="All keys" searchPlaceholder="Search keys…" className={className}>
      <div className="mb-1.5 border-b border-line px-1 pb-2">
        <KeyStatusFilter value={statuses} onChange={setStatuses} />
      </div>
    </Combobox>
  );
}
