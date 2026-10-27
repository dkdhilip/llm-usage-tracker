import { useState } from "react";
import type { ByKeyRow } from "../lib/api";
import { Card } from "./Card";
import { num, relTime, tokens, usd } from "../lib/format";
import { DEFAULT_KEY_STATUSES, type KeyStatus } from "../lib/keyOptions";
import { KeyStatusFilter } from "./KeyStatusFilter";

type SortKey = "cost" | "total_tokens" | "requests";

export function KeyUsageTable({
  rows,
  statusOf,
}: {
  rows: ByKeyRow[];
  /** a key's status; the Dashboard passes "active" for a key it does not know */
  statusOf: (keyId: number) => KeyStatus;
}) {
  const [sort, setSort] = useState<SortKey>("cost");
  const [statuses, setStatuses] = useState<KeyStatus[]>(DEFAULT_KEY_STATUSES);
  const shown = rows.filter((r) => statuses.includes(statusOf(r.key_id)));
  const sorted = [...shown].sort((a, b) => b[sort] - a[sort]);

  const header = (key: SortKey, label: string) => (
    <button
      onClick={() => setSort(key)}
      className={`font-medium ${sort === key ? "text-brand-600" : "text-fg-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );

  return (
    <Card title="Per-key usage" right={<KeyStatusFilter value={statuses} onChange={setStatuses} />}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-subtle">
              <th className="py-2 pr-4">User / Label</th>
              <th className="py-2 pr-4">Key prefix</th>
              <th className="py-2 pr-4 text-right">{header("requests", "Requests")}</th>
              <th className="py-2 pr-4 text-right">{header("total_tokens", "Total tokens")}</th>
              <th className="py-2 pr-4 text-right">{header("cost", "Cost")}</th>
              <th className="py-2 pr-0 text-right">Last used</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-fg-subtle">
                  {rows.length === 0 ? "No usage in this range yet" : "No keys with these statuses in this range"}
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.key_id} className="border-b border-line last:border-0">
                <td className="py-2 pr-4 font-medium text-fg">
                  {r.label}
                  {statusOf(r.key_id) !== "active" && (
                    <span className="ml-2 text-xs font-normal capitalize text-fg-subtle">{statusOf(r.key_id)}</span>
                  )}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-fg-muted">
                  {r.key_prefix}…
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{num(r.requests)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{tokens(r.total_tokens)}</td>
                <td className="py-2 pr-4 text-right tabular-nums font-medium">
                  {usd(r.cost)}
                </td>
                <td className="py-2 pr-0 text-right text-xs text-fg-subtle">
                  {relTime(r.last_used_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
