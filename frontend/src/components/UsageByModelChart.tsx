import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ByModelRow } from "../lib/api";
import { Card } from "./Card";
import { providerColor } from "../lib/chartColors";
import { providerName, tokens } from "../lib/format";
import { chartTheme, useTheme } from "../lib/theme";

const SUMMARY_MODELS = 8;

/** The bars in words: the models with the most tokens, largest first. */
export function modelsSummary(rows: { name: string; tokens: number }[]): string {
  if (rows.length === 0) return "No usage in this range yet.";
  const top = rows.slice(0, SUMMARY_MODELS).map((r) => `${r.name} ${tokens(r.tokens)}`);
  const more = rows.length - top.length;
  return `Tokens by model, most first: ${top.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

const short = (s: string) => (s.length > 30 ? s.slice(0, 29) + "…" : s);

export function UsageByModelChart({ data }: { data: ByModelRow[] }) {
  const ct = chartTheme(useTheme().isDark);
  const rows = [...data]
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .map((r) => ({ name: r.model, tokens: r.total_tokens, provider: r.provider }));
  const providers = [...new Set(rows.map((r) => r.provider))];
  const summary = modelsSummary(rows);

  return (
    <Card
      title="Tokens by model"
      right={
        providers.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            {providers.map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: providerColor(p) }} />
                <span>{providerName(p)}</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      <div className="h-72 w-full" role={rows.length === 0 ? undefined : "img"} aria-label={rows.length === 0 ? undefined : summary}>
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No usage in this range yet
          </div>
        ) : (
          <div className="h-full w-full" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              accessibilityLayer={false}
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
              barCategoryGap="28%"
            >
              <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11 }}
                stroke={ct.axis}
                tickLine={false}
                tickFormatter={(v: number) => tokens(v)}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11 }}
                stroke={ct.axis}
                tickLine={false}
                tickFormatter={short}
                width={190}
              />
              <Tooltip
                cursor={{ fill: ct.grid, opacity: 0.5 }}
                formatter={(v: number) => `${v.toLocaleString()} tokens`}
                contentStyle={ct.tooltip.contentStyle}
                labelStyle={ct.tooltip.labelStyle}
                itemStyle={ct.tooltip.itemStyle}
              />
              <Bar dataKey="tokens" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                {rows.map((r) => (
                  <Cell key={`${r.provider}/${r.name}`} fill={providerColor(r.provider)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}
