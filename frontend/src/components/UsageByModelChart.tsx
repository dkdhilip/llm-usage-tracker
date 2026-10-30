import { useState } from "react";
import type { ByModelRow } from "../lib/api";
import { Card } from "./Card";
import { Button } from "./ui/Button";
import { PanelPlaceholder, type PanelStatus } from "./ui/PanelState";
import { providerColor } from "../lib/chartColors";
import { providerName, tokens } from "../lib/format";

/** How many models show before "Show all". */
export const TOP_MODELS = 8;

/** The models with the most tokens as bars, largest first. The full name is always in the page (truncated by width,
 *  with the whole name as a tooltip), and the provider is named in text as well as colour. */
export function UsageByModelChart({ data, state = "ready" }: { data: ByModelRow[]; state?: PanelStatus }) {
  const [all, setAll] = useState(false);
  const rows = [...data].sort((a, b) => b.total_tokens - a.total_tokens);
  const shown = all ? rows : rows.slice(0, TOP_MODELS);
  const max = rows[0]?.total_tokens || 1;
  const providers = [...new Set(rows.map((r) => r.provider))];

  if (state !== "ready") {
    return (
      <Card title="Tokens by model">
        <PanelPlaceholder state={state} className="h-72" />
      </Card>
    );
  }

  return (
    <Card
      title="Tokens by model"
      right={
        providers.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-fg-muted" aria-label="Providers">
            {providers.map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: providerColor(p) }} aria-hidden="true" />
                <span>{providerName(p)}</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-fg-subtle">No usage in this range yet</div>
      ) : (
        <>
          <ul aria-label="Tokens by model, most first">
            {shown.map((r) => (
              <li
                key={`${r.provider}/${r.model}`}
                className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-3 py-1.5 text-ui sm:grid-cols-[12rem_1fr_3.5rem]"
              >
                <span className="min-w-0 truncate font-mono text-fg" title={`${r.model} (${providerName(r.provider)})`}>
                  <span className="sr-only">{providerName(r.provider)}: </span>
                  {r.model}
                </span>
                <span className="h-2 overflow-hidden rounded bg-fill" aria-hidden="true">
                  <span
                    className="block h-full rounded"
                    style={{ width: `${Math.max((r.total_tokens / max) * 100, 1)}%`, background: providerColor(r.provider) }}
                  />
                </span>
                <span className="text-right tabular-nums text-fg">{tokens(r.total_tokens)}</span>
              </li>
            ))}
          </ul>
          {rows.length > TOP_MODELS && (
            <div className="mt-2">
              <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                {all ? "Show top 8" : `Show all ${rows.length} models`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
