import type { ReactNode } from "react";
import { PROVIDERS, type KeyRow } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Combobox } from "../../components/ui/Combobox";
import { providerName } from "../../lib/format";

const FIELD =
  "h-8 rounded-md border border-control bg-surface px-2.5 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-meta font-medium uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

/** The request filters. Every filter lives in the URL (so a filtered view can be shared and survives a reload). */
export function RequestFilters({
  get,
  set,
  keys,
  models,
  hasFilters,
  onClear,
}: {
  get: (key: string) => string;
  set: (key: string, value: string) => void;
  keys: KeyRow[];
  /** model names for the Model list, already narrowed to the chosen provider */
  models: string[];
  hasFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
      <Field label="Key">
        <select className={FIELD} value={get("key_id")} onChange={(e) => set("key_id", e.target.value)}>
          <option value="">All keys</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Provider">
        <select className={FIELD} value={get("provider")} onChange={(e) => set("provider", e.target.value)}>
          <option value="">All</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {providerName(p)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model">
        <Combobox
          label="Model"
          value={get("model")}
          onChange={(m) => set("model", m)}
          options={models.map((m) => ({ value: m, label: m }))}
          allLabel="All models"
          searchPlaceholder="Search models…"
        />
      </Field>
      <Field label="Status">
        <select className={FIELD} value={get("status")} onChange={(e) => set("status", e.target.value)}>
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
      </Field>
      <Field label="From">
        <input type="date" className={FIELD} value={get("start").slice(0, 10)} onChange={(e) => set("start", e.target.value)} />
      </Field>
      <Field label="To">
        <input type="date" className={FIELD} value={get("end").slice(0, 10)} onChange={(e) => set("end", e.target.value)} />
      </Field>
      {hasFilters && (
        <Button variant="ghost" size="sm" className="ml-auto self-center" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
