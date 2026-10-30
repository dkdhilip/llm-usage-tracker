import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TimeseriesPoint } from "../lib/api";
import { Card } from "./Card";
import { PanelPlaceholder, type PanelStatus } from "./ui/PanelState";
import { SegmentedControl } from "./ui/SegmentedControl";
import { providerColor } from "../lib/chartColors";
import { costLabel, num, providerName, tokens, usd } from "../lib/format";
import { chartTheme, useTheme } from "../lib/theme";

export type Metric = "requests" | "total_tokens" | "cost";

const METRICS: { id: Metric; label: string; unit: string }[] = [
  { id: "requests", label: "Requests", unit: "requests" },
  { id: "total_tokens", label: "Tokens", unit: "tokens" },
  { id: "cost", label: "Cost", unit: "cost" },
];

const MAX_FILLED_DAYS = 120; // beyond this, only days that had usage are drawn

const DAY_MS = 86_400_000;
const dayToMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const msToDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "Oct 26" for a YYYY-MM-DD day (UTC, so the label never shifts with the viewer's time zone). */
export function dayLabel(day: string, withWeekday = false): string {
  return new Date(dayToMs(day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(withWeekday ? { weekday: "short" } : {}),
  });
}

/** The value as text in the units of `metric`. */
export function formatMetric(metric: Metric, v: number): string {
  if (metric === "cost") return usd(v);
  if (metric === "total_tokens") return tokens(v);
  return num(v);
}

/** A short y-axis label: "$0.0014", "12K", "40". */
function axisLabel(metric: Metric, v: number): string {
  if (v === 0) return metric === "cost" ? "$0" : "0";
  if (metric === "cost") return v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(2))}`;
  if (metric === "total_tokens") return tokens(v);
  return num(Math.round(v));
}

export interface DailyRow {
  day: string;
  total: number;
  [provider: string]: string | number;
}

/** One row per calendar day from the first to the last day that has data (days without usage are 0, so the bars
 *  show the real gaps), the providers in order of their period total (largest first), and each provider's total. */
export function buildDaily(data: TimeseriesPoint[], metric: Metric) {
  const perDay = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  const requestsBy = new Map<string, number>();
  const unpricedBy = new Map<string, number>();
  for (const p of data) {
    requestsBy.set(p.provider, (requestsBy.get(p.provider) ?? 0) + p.requests);
    unpricedBy.set(p.provider, (unpricedBy.get(p.provider) ?? 0) + (p.unpriced_requests ?? 0));
    const v = Number(p[metric]) || 0;
    const m = perDay.get(p.day) ?? new Map<string, number>();
    m.set(p.provider, (m.get(p.provider) ?? 0) + v);
    perDay.set(p.day, m);
    totals.set(p.provider, (totals.get(p.provider) ?? 0) + v);
  }
  // an API that does not send the unpriced count leaves it unknown, and cost then reads a 0 total as "no price"
  const unpricedKnown = data.every((p) => p.unpriced_requests !== undefined);
  const days = [...perDay.keys()].sort();
  let axisDays = days;
  if (days.length > 1) {
    const first = dayToMs(days[0]);
    const span = Math.round((dayToMs(days[days.length - 1]) - first) / DAY_MS) + 1;
    if (span <= MAX_FILLED_DAYS) axisDays = Array.from({ length: span }, (_, i) => msToDay(first + i * DAY_MS));
  }
  const providers = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const rows: DailyRow[] = axisDays.map((day) => {
    const m = perDay.get(day);
    const row: DailyRow = { day, total: 0 };
    for (const p of providers) {
      const v = m?.get(p) ?? 0;
      row[p] = v;
      row.total += v;
    }
    return row;
  });
  const grand = providers.reduce((a, p) => a + (totals.get(p) ?? 0), 0);
  return {
    rows,
    providers,
    totals,
    requestsBy,
    unpricedBy,
    unpricedKnown,
    grand,
    requests: data.reduce((a, p) => a + p.requests, 0),
  };
}

export type Daily = ReturnType<typeof buildDaily>;

export interface LegendEntry {
  provider: string;
  text: string;
  note?: string;
  /** cost view only: the provider's requests have no price, so there is no amount to show */
  unknown: boolean;
  title?: string;
}

/** What each provider's number reads as. In the cost view a provider whose requests have no price says so
 *  instead of "$0.000000", which would read as "free". */
export function legendEntries(d: Daily, metric: Metric): LegendEntry[] {
  return d.providers.map((p) => {
    const total = d.totals.get(p) ?? 0;
    if (metric !== "cost") return { provider: p, text: formatMetric(metric, total), unknown: false };
    const c = costLabel(total, d.requestsBy.get(p) ?? 0, d.unpricedKnown ? d.unpricedBy.get(p) : undefined);
    return { provider: p, text: c.text, note: c.note, unknown: c.unknown, title: c.title };
  });
}

/** The chart in words, for people who cannot see it (a screen reader announces this instead of the drawing). */
export function overTimeSummary(d: Daily, metric: Metric): string {
  if (d.rows.length === 0) return "No usage in this range yet.";
  const label = METRICS.find((m) => m.id === metric)!.label;
  const n = d.rows.length;
  const peak = d.rows.reduce((a, r) => (r.total > a.total ? r : a), d.rows[0]);
  const by = legendEntries(d, metric)
    .map((e) => `${providerName(e.provider)} ${e.text}${e.note ? ` ${e.note}` : ""}`)
    .join(", ");
  return (
    `${label} per day over ${n} ${n === 1 ? "day" : "days"}, ${formatMetric(metric, d.grand)} in total. ` +
    (peak.total > 0 ? `Busiest day ${dayLabel(peak.day)} with ${formatMetric(metric, peak.total)}. ` : "") +
    `By provider: ${by}.`
  );
}

export function DayTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
  metric: Metric;
}) {
  if (!active || !payload?.length || !label) return null;
  const items = payload.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((a, p) => a + p.value, 0);
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-fg">{dayLabel(label, true)}</div>
      {items.length === 0 ? (
        <div className="text-fg-subtle">No usage</div>
      ) : (
        <>
          {items.map((p) => (
            <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
              <span className="text-fg-muted" data-testid="tip-name">{providerName(p.dataKey)}</span>
              <span className="ml-auto pl-4 tabular-nums text-fg">{formatMetric(metric, p.value)}</span>
            </div>
          ))}
          {items.length > 1 && (
            <div className="mt-1 flex border-t border-line pt-1 text-fg">
              <span>Total</span>
              <span className="ml-auto tabular-nums">{formatMetric(metric, total)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Usage per day as stacked bars (one colour per provider), with the period total as the headline and a legend
 *  that gives every provider its own number, so a small provider is readable even when its bar is thin. */
export function UsageOverTimeChart({ data, state = "ready" }: { data: TimeseriesPoint[]; state?: PanelStatus }) {
  const [metric, setMetric] = useState<Metric>("requests");
  const ct = chartTheme(useTheme().isDark);
  const daily = useMemo(() => buildDaily(data, metric), [data, metric]);
  const { rows, grand, requests } = daily;
  const legend = useMemo(() => legendEntries(daily, metric), [daily, metric]);
  const summary = useMemo(() => overTimeSummary(daily, metric), [daily, metric]);
  const unit = METRICS.find((m) => m.id === metric)!.unit;
  const days = rows.length;
  const span = days === 1 ? "1 day" : `${days} days`;

  if (state !== "ready") {
    return (
      <Card title="Usage over time">
        <PanelPlaceholder state={state} className="h-72" />
      </Card>
    );
  }

  return (
    <Card
      title="Usage over time"
      right={
        <SegmentedControl label="Metric" options={METRICS.map((m) => ({ value: m.id, label: m.label }))} value={metric} onChange={setMetric} />
      }
    >
      {days === 0 ? (
        <div className="flex h-72 items-center justify-center text-sm text-fg-subtle">No usage in this range yet</div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <div className="text-kpi font-semibold tabular-nums text-fg" data-testid="usage-total">
                {formatMetric(metric, grand)}
              </div>
              <div className="text-xs text-fg-subtle">
                {metric === "requests"
                  ? `requests over ${span}`
                  : `${unit} over ${span} · ${num(requests)} ${requests === 1 ? "request" : "requests"}`}
              </div>
            </div>
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-label="Total per provider">
              {legend.map((e) => (
                <li key={e.provider} className="flex items-center gap-1.5" data-testid={`usage-legend-${e.provider}`}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: providerColor(e.provider) }} />
                  <span className="text-fg-muted">{providerName(e.provider)}</span>
                  {e.unknown ? (
                    // $0 would read as "free"; it means these models have no price in the catalog yet
                    <span className="text-xs text-fg-muted" title={e.title}>
                      {e.text}
                    </span>
                  ) : (
                    <span className="tabular-nums font-medium text-fg" title={e.title}>
                      {e.text}
                      {e.note && <span className="ml-1 text-xs font-normal text-fg-muted">{e.note}</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {/* The drawing is described in words for a screen reader; the legend above already has the numbers. */}
          <div className="h-64 w-full" role="img" aria-label={summary}>
            <div className="h-full w-full" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="25%" accessibilityLayer={false}>
                <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d: string) => dayLabel(d)}
                  tick={{ fontSize: 11 }}
                  stroke={ct.axis}
                  tickLine={false}
                  minTickGap={16}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke={ct.axis}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={metric !== "requests"}
                  tickCount={4}
                  tickFormatter={(v: number) => axisLabel(metric, v)}
                  width={56}
                />
                <Tooltip
                  cursor={{ fill: ct.grid, opacity: 0.35 }}
                  content={<DayTooltip metric={metric} />}
                />
                {daily.providers.map((p) => (
                  <Bar
                    key={p}
                    dataKey={p}
                    stackId="day"
                    fill={providerColor(p)}
                    maxBarSize={40}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
