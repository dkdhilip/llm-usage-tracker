import type { ModelInfo } from "../lib/api";
import type { KeyOption } from "../lib/keyOptions";
import { KeyPicker } from "./KeyPicker";
import { Combobox } from "./ui/Combobox";
import { Button } from "./ui/Button";
import { SegmentedControl } from "./ui/SegmentedControl";
import { XIcon } from "./ui/icons";
import { providerName } from "../lib/format";
import {
  DEFAULT_RANGE_DAYS,
  RANGE_OPTIONS,
  isoDate,
  type Filters,
} from "../lib/filters";

const selectClass =
  "h-8 rounded-md border border-control bg-surface px-2.5 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text";

const RANGES = [
  ...RANGE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
  { value: "custom", label: "Custom" },
];

/** A filter that is on, with a button to take it off. The button's name says which filter it removes. */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full bg-info-soft pl-2.5 pr-0.5 text-ui font-medium text-info-fg">
      {label}
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        onClick={onRemove}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text"
      >
        <XIcon aria-hidden="true" />
      </button>
    </span>
  );
}

export function FilterBar({
  filters,
  onChange,
  models,
  keys,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  models: ModelInfo[];
  keys: KeyOption[];
}) {
  const providers = Array.from(new Set(models.map((m) => m.provider)));
  const visibleModels = filters.provider
    ? models.filter((m) => m.provider === filters.provider)
    : models;
  const custom = filters.start !== "";
  const dirty =
    filters.provider ||
    filters.model ||
    filters.keyId ||
    custom ||
    filters.rangeDays !== DEFAULT_RANGE_DAYS;
  const keyLabel = keys.find((k) => String(k.key_id) === filters.keyId)?.label ?? `#${filters.keyId}`;

  return (
    <div
      role="group"
      aria-label="Filters"
      className="sticky top-2 z-20 rounded-xl border border-line bg-surface p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Time range"
          options={RANGES}
          value={custom ? "custom" : String(filters.rangeDays)}
          onChange={(v) =>
            onChange(
              v === "custom"
                ? { ...filters, start: isoDate(7), end: isoDate(0) }
                : { ...filters, rangeDays: Number(v), start: "", end: "" },
            )
          }
        />

        {custom && (
          <div className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="date"
              aria-label="From date"
              className={selectClass}
              value={filters.start}
              max={filters.end || isoDate(0)}
              onChange={(e) => onChange({ ...filters, start: e.target.value })}
            />
            <span className="text-fg-subtle" aria-hidden="true">→</span>
            <input
              type="date"
              aria-label="To date"
              className={selectClass}
              value={filters.end}
              min={filters.start}
              max={isoDate(0)}
              onChange={(e) => onChange({ ...filters, end: e.target.value })}
            />
          </div>
        )}

        <select
          aria-label="Provider"
          className={selectClass}
          value={filters.provider}
          onChange={(e) =>
            onChange({ ...filters, provider: e.target.value, model: "" })
          }
        >
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerName(p)}
            </option>
          ))}
        </select>

        <Combobox
          label="Model"
          value={filters.model}
          onChange={(model) => onChange({ ...filters, model })}
          options={visibleModels.map((m) => ({ value: m.model, label: m.model }))}
          allLabel="All models"
          searchPlaceholder="Search models…"
        />

        <KeyPicker
          keys={keys}
          value={filters.keyId}
          onChange={(keyId) => onChange({ ...filters, keyId })}
        />

        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() =>
              onChange({
                rangeDays: DEFAULT_RANGE_DAYS,
                start: "",
                end: "",
                provider: "",
                model: "",
                keyId: "",
              })
            }
          >
            Reset filters
          </Button>
        )}
      </div>

      {(filters.provider || filters.model || filters.keyId) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2" aria-label="Active filters" role="group">
          {filters.provider && (
            <FilterChip label={`Provider: ${providerName(filters.provider)}`} onRemove={() => onChange({ ...filters, provider: "" })} />
          )}
          {filters.model && <FilterChip label={`Model: ${filters.model}`} onRemove={() => onChange({ ...filters, model: "" })} />}
          {filters.keyId && <FilterChip label={`Key: ${keyLabel}`} onRemove={() => onChange({ ...filters, keyId: "" })} />}
        </div>
      )}
    </div>
  );
}
