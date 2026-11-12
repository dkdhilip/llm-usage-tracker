import type { ReactNode } from "react";
import { PROVIDERS, type KeyRow } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Combobox } from "../../components/ui/Combobox";
import { providerName } from "../../lib/format";

const FIELD =
  "h-8 rounded-md border border-control bg-surface px-2.5 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text";

const STATUS_OPTIONS = [
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "blocked", label: "Blocked" },
];

const RULE_OPTIONS = [
  { value: "any", label: "Matched a rule" },
  { value: "blocked", label: "Blocked by a rule" },
  { value: "flagged", label: "Flagged by a rule" },
  { value: "unchecked", label: "Not fully checked" },
];

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
        <Combobox
          label="Key"
          value={get("key_id")}
          onChange={(v) => set("key_id", v)}
          options={keys.map((k) => ({ value: String(k.id), label: k.label }))}
          allLabel="All keys"
          searchPlaceholder="Search keys…"
        />
      </Field>
      <Field label="Provider">
        <Combobox
          label="Provider"
          value={get("provider")}
          onChange={(v) => set("provider", v)}
          options={PROVIDERS.map((p) => ({ value: p, label: providerName(p) }))}
          allLabel="All providers"
          searchable={false}
        />
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
        <Combobox
          label="Status"
          value={get("status")}
          onChange={(v) => set("status", v)}
          options={STATUS_OPTIONS}
          allLabel="All statuses"
          searchable={false}
        />
      </Field>
      <Field label="Content rules">
        <Combobox
          label="Content rules"
          value={get("guardrail")}
          onChange={(v) => set("guardrail", v)}
          options={RULE_OPTIONS}
          allLabel="All requests"
          searchable={false}
        />
      </Field>
      {/* From and To sit together, so the pair wraps to the next line as one and never leaves a lone date behind */}
      <div role="group" aria-label="Date range" className="flex min-w-0 flex-col gap-1">
        <span className="text-meta font-medium uppercase tracking-wide text-fg-muted">Date range</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" aria-label="From date" className={FIELD} value={get("start").slice(0, 10)} max={get("end").slice(0, 10) || undefined} onChange={(e) => set("start", e.target.value)} />
          <span className="text-fg-subtle" aria-hidden="true">→</span>
          <input type="date" aria-label="To date" className={FIELD} value={get("end").slice(0, 10)} min={get("start").slice(0, 10) || undefined} onChange={(e) => set("end", e.target.value)} />
        </div>
      </div>
      {hasFilters && (
        <Button variant="ghost" size="sm" className="ml-auto self-center" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
