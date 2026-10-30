import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { ByModelRow } from "../lib/api";
import { Card } from "./Card";
import { PanelPlaceholder, type PanelStatus } from "./ui/PanelState";
import { providerColor, shareLabel } from "../lib/chartColors";
import { providerName, tokens } from "../lib/format";
import { chartTheme, useTheme } from "../lib/theme";

/** The ring in words: each provider's share, largest first. */
export function providerShareSummary(slices: { provider: string; value: number }[], total: number): string {
  if (total === 0) return "No usage in this range yet.";
  return (
    `Share of ${tokens(total)} tokens by provider: ` +
    slices.map((s) => `${providerName(s.provider)} ${shareLabel(s.value, total)} (${tokens(s.value)})`).join(", ") +
    "."
  );
}

export function UsageByProviderChart({ data, state = "ready" }: { data: ByModelRow[]; state?: PanelStatus }) {
  const ct = chartTheme(useTheme().isDark);
  const slices = useMemo(() => {
    const byProvider = new Map<string, number>();
    for (const r of data) {
      byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.total_tokens);
    }
    return [...byProvider.entries()]
      .map(([provider, value]) => ({ provider, value, color: providerColor(provider) }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const total = slices.reduce((a, s) => a + s.value, 0);
  const summary = providerShareSummary(slices, total);

  if (state !== "ready") {
    return (
      <Card title="Usage by provider">
        <PanelPlaceholder state={state} className="h-56" />
      </Card>
    );
  }

  return (
    <Card title="Usage by provider">
      <div className="min-h-72 w-full">
        {total === 0 ? (
          <div className="flex h-72 items-center justify-center text-sm text-fg-subtle">
            No usage in this range yet
          </div>
        ) : (
          // The names live in a legend beside the ring (not as labels on it), so small slices can never
          // overlap each other's text, and every provider stays readable however thin its slice is.
          <div className="flex min-h-72 flex-col items-center justify-center gap-6 sm:flex-row">
            <div className="relative h-56 w-56 shrink-0" role="img" aria-label={summary}>
              <div className="h-full w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart accessibilityLayer={false}>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="provider"
                    innerRadius="68%"
                    outerRadius="100%"
                    paddingAngle={slices.length > 1 ? 3 : 0}
                    minAngle={4}
                    cornerRadius={5}
                    stroke="none"
                    startAngle={90}
                    endAngle={-270}
                    rootTabIndex={-1}
                    isAnimationActive={false}
                  >
                    {slices.map((s) => (
                      <Cell key={s.provider} fill={s.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      `${tokens(v)} tokens (${shareLabel(v, total)})`,
                      name,
                    ]}
                    contentStyle={ct.tooltip.contentStyle}
                    labelStyle={ct.tooltip.labelStyle}
                    itemStyle={ct.tooltip.itemStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
              </div>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <div className="text-2xl font-semibold tabular-nums text-fg">{tokens(total)}</div>
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle">tokens</div>
              </div>
            </div>
            <ul className="w-full max-w-xs space-y-2.5" aria-label="Provider share of tokens">
              {slices.map((s) => (
                <li key={s.provider} className="flex items-center gap-2.5 text-sm" data-testid={`provider-${s.provider}`}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="font-medium text-fg">{providerName(s.provider)}</span>
                  <span className="ml-auto tabular-nums text-fg-muted">{tokens(s.value)}</span>
                  <span className="w-12 text-right text-xs tabular-nums text-fg-subtle">
                    {shareLabel(s.value, total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
