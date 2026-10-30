import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type ByKeyRow,
  type ByModelRow,
  type ModelInfo,
  type TimeseriesPoint,
  type UsageSummary,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { keyOptions, type KeyOption } from "../lib/keyOptions";
import { defaultFilters, describeRange, toQuery, type Filters } from "../lib/filters";
import { num } from "../lib/format";
import { FilterBar } from "../components/FilterBar";
import { Button } from "../components/ui/Button";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshIcon } from "../components/ui/icons";
import type { PanelStatus } from "../components/ui/PanelState";
import { SummaryCards } from "../components/SummaryCards";
import { UsageOverTimeChart } from "../components/UsageOverTimeChart";
import { UsageByProviderChart } from "../components/UsageByProviderChart";
import { UsageByModelChart } from "../components/UsageByModelChart";
import { KeyUsageTable } from "../components/KeyUsageTable";

export function Dashboard() {
  const { isWorkspaceAdmin, workspace } = useAuth();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [byKey, setByKey] = useState<ByKeyRow[]>([]);
  const [byModel, setByModel] = useState<ByModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  const load = useCallback(() => {
    const qs = toQuery(filters);
    setLoading(true);
    setError(null);
    Promise.all([
      api.usageSummary(qs),
      api.usageTimeseries(qs),
      api.usageByKey(qs),
      api.usageByModel(qs),
    ])
      .then(([s, ts, bk, bm]) => {
        setSummary(s);
        setTimeseries(ts);
        setByKey(bk);
        setByModel(bm);
        setUpdatedAt(new Date());
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // key list for the filter dropdown: every key (even one with no requests yet) plus any key that has usage
  const [allKeys, setAllKeys] = useState<KeyOption[]>([]);
  useEffect(() => {
    Promise.all([
      api.listKeys().catch(() => []),
      api.usageByKey("").catch(() => []),
    ]).then(([keys, used]) => setAllKeys(keyOptions(keys, used)));
  }, []);

  const statusById = useMemo(() => new Map(allKeys.map((k) => [k.key_id, k.status])), [allKeys]);

  // A panel is only "loading" until its first data arrives (a later reload keeps showing what it has), and a
  // failed load says so: it never shows "No usage", which would mean "loaded, and there is none".
  const state: PanelStatus = error ? "error" : loading && !summary ? "loading" : "ready";

  const scope = isWorkspaceAdmin ? (workspace?.name ?? "Workspace") : "Your assigned keys";
  const context = [
    scope,
    describeRange(filters),
    summary && !error ? `${num(summary.total_requests)} request${summary.total_requests === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-4">
      <PageHeader
        className="mb-0"
        title="Usage"
        description={context}
        actions={
          <>
            {updatedAt && !error && (
              <span className="text-ui text-fg-muted">
                Updated {updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            {/* aria-disabled, not disabled: a focused button that turns disabled would drop the keyboard user's place */}
            <Button onClick={() => !loading && load()} aria-disabled={loading || undefined} aria-busy={loading}>
              <RefreshIcon aria-hidden="true" /> {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />

      <FilterBar filters={filters} onChange={setFilters} models={models} keys={allKeys} />

      {error && (
        <InlineAlert
          tone="error"
          title="Couldn't load usage"
          action={
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </InlineAlert>
      )}

      <SummaryCards data={error ? null : summary} loading={loading} error={!!error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <UsageOverTimeChart data={timeseries} state={state} />
        <UsageByProviderChart data={byModel} state={state} />
      </div>

      <UsageByModelChart data={byModel} state={state} />

      <KeyUsageTable rows={byKey} statusOf={(id) => statusById.get(id) ?? "active"} state={state} />
    </div>
  );
}
