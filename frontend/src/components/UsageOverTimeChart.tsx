import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeseriesPoint } from "../lib/api";
import { Card } from "./Card";
import { providerColor } from "../lib/chartColors";
import { usd } from "../lib/format";
import { chartTheme, useTheme } from "../lib/theme";

type Metric = "cost" | "total_tokens";

export function UsageOverTimeChart({ data }: { data: TimeseriesPoint[] }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const ct = chartTheme(useTheme().isDark);

  const { rows, providers } = useMemo(() => {
    const providerSet = new Set<string>();
    const byDay = new Map<string, Record<string, string | number>>();
    for (const p of data) {
      providerSet.add(p.provider);
      const row = byDay.get(p.day) ?? { day: p.day };
      row[p.provider] = ((row[p.provider] as number) ?? 0) + p[metric];
      byDay.set(p.day, row);
    }
    const sorted = [...byDay.values()].sort((a, b) =>
      String(a.day).localeCompare(String(b.day)),
    );
    return { rows: sorted, providers: [...providerSet] };
  }, [data, metric]);

  return (
    <Card
      title="Usage over time"
      right={
        <div className="flex overflow-hidden rounded-md border border-line text-xs">
          {(["cost", "total_tokens"] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 ${
                metric === m
                  ? "bg-brand-600 text-white"
                  : "bg-surface text-fg-muted hover:bg-fill"
              }`}
            >
              {m === "cost" ? "Cost" : "Tokens"}
            </button>
          ))}
        </div>
      }
    >
      {providers.length > 0 && (
        <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          {providers.map((p) => (
            <li key={p} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: providerColor(p) }} />
              <span className="capitalize">{p}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="h-72 w-full">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No usage in this range yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                {providers.map((p, i) => (
                  <linearGradient key={p} id={`usage-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={providerColor(p)} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={providerColor(p)} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke={ct.axis} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke={ct.axis}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (metric === "cost" ? usd(v) : String(v))}
                width={60}
              />
              <Tooltip
                formatter={(v: number) => (metric === "cost" ? usd(v) : v.toLocaleString())}
                contentStyle={ct.tooltip.contentStyle}
                labelStyle={ct.tooltip.labelStyle}
                itemStyle={ct.tooltip.itemStyle}
              />
              {providers.map((p, i) => (
                <Area
                  key={p}
                  type="monotone"
                  dataKey={p}
                  stackId="1"
                  stroke={providerColor(p)}
                  strokeWidth={2}
                  fill={`url(#usage-fill-${i})`}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
