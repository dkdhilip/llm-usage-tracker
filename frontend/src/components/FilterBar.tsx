import type { ModelInfo } from "../lib/api";
import type { KeyOption } from "../lib/keyOptions";
import { KeyPicker } from "./KeyPicker";
import { providerName } from "../lib/format";
import {
  DEFAULT_RANGE_DAYS,
  RANGE_OPTIONS,
  isoDate,
  type Filters,
} from "../lib/filters";

const selectClass =
  "rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg focus:border-brand-500 focus:outline-none";

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

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-sm">
      <div className="flex overflow-hidden rounded-md border border-line">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() =>
              onChange({ ...filters, rangeDays: opt.value, start: "", end: "" })
            }
            className={`px-3 py-1.5 text-sm ${
              !custom && filters.rangeDays === opt.value
                ? "bg-brand-600 text-white"
                : "bg-surface text-fg-muted hover:bg-fill"
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() =>
            onChange({ ...filters, start: isoDate(7), end: isoDate(0) })
          }
          className={`px-3 py-1.5 text-sm ${
            custom
              ? "bg-brand-600 text-white"
              : "bg-surface text-fg-muted hover:bg-fill"
          }`}
        >
          Custom
        </button>
      </div>

      {custom && (
        <div className="flex items-center gap-1.5 text-sm text-fg-muted">
          <input
            type="date"
            className={selectClass}
            value={filters.start}
            max={filters.end || isoDate(0)}
            onChange={(e) => onChange({ ...filters, start: e.target.value })}
          />
          <span className="text-fg-subtle">→</span>
          <input
            type="date"
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

      <select
        aria-label="Model"
        className={selectClass}
        value={filters.model}
        onChange={(e) => onChange({ ...filters, model: e.target.value })}
      >
        <option value="">All models</option>
        {visibleModels.map((m) => (
          <option key={`${m.provider}/${m.model}`} value={m.model}>
            {m.model}
          </option>
        ))}
      </select>

      <KeyPicker
        className={selectClass}
        keys={keys}
        value={filters.keyId}
        onChange={(keyId) => onChange({ ...filters, keyId })}
      />

      {dirty && (
        <button
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
          className="ml-auto text-sm text-brand-600 hover:underline"
        >
          Reset
        </button>
      )}
    </div>
  );
}
