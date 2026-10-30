import { useMemo } from "react";
import type { ByModelRow } from "../lib/api";
import { Card } from "./Card";
import { PanelPlaceholder, type PanelStatus } from "./ui/PanelState";
import { providerColor, shareLabel } from "../lib/chartColors";
import { providerName, tokens } from "../lib/format";

/** Each provider's share of the tokens as a bar with its own numbers, largest first. A list of bars, not a ring: the
 *  names and values sit in plain text beside the bars, so a thin slice is as readable as a large one. */
export function UsageByProviderChart({ data, state = "ready" }: { data: ByModelRow[]; state?: PanelStatus }) {
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

  if (state !== "ready") {
    return (
      <Card title="Share by provider">
        <PanelPlaceholder state={state} className="h-56" />
      </Card>
    );
  }

  return (
    <Card title="Share by provider" right={<span className="text-ui text-fg-muted">tokens</span>}>
      {total === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-fg-subtle">No usage in this range yet</div>
      ) : (
        <ul className="divide-y divide-line" aria-label="Provider share of tokens">
          {slices.map((s) => {
            const pct = (s.value / total) * 100;
            return (
              <li
                key={s.provider}
                className="grid grid-cols-[6.5rem_1fr_3.75rem_2.75rem] items-center gap-3 py-2.5 text-sm sm:grid-cols-[7rem_1fr_4rem_3rem]"
                data-testid={`provider-${s.provider}`}
              >
                <span className="flex min-w-0 items-center gap-2 font-medium text-fg">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
                  <span className="truncate">{providerName(s.provider)}</span>
                </span>
                <span className="h-2 overflow-hidden rounded bg-fill" aria-hidden="true">
                  <span className="block h-full rounded" style={{ width: `${Math.max(pct, 1)}%`, background: s.color }} />
                </span>
                <span className="text-right tabular-nums text-fg">{tokens(s.value)}</span>
                <span className="text-right text-ui tabular-nums text-fg-muted">{shareLabel(s.value, total)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
