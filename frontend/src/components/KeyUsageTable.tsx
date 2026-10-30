import { useState } from "react";
import type { ByKeyRow } from "../lib/api";
import { Card } from "./Card";
import { num, relTime, tokens } from "../lib/format";
import { CostCell } from "./CostCell";
import { DEFAULT_KEY_STATUSES, type KeyStatus } from "../lib/keyOptions";
import { KeyStatusFilter } from "./KeyStatusFilter";
import { PanelPlaceholder, type PanelStatus } from "./ui/PanelState";
import { SegmentedControl } from "./ui/SegmentedControl";
import { PHONE_QUERY, useMediaQuery } from "../lib/useMediaQuery";

type SortKey = "cost" | "total_tokens" | "requests";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "requests", label: "Requests" },
  { value: "total_tokens", label: "Tokens" },
];

/** Usage per key: a table on a desktop, one stacked card per key on a phone (the same rows, never both at once). */
export function KeyUsageTable({
  rows,
  statusOf,
  state = "ready",
}: {
  state?: PanelStatus;
  rows: ByKeyRow[];
  /** a key's status; the Dashboard passes "active" for a key it does not know */
  statusOf: (keyId: number) => KeyStatus;
}) {
  const [sort, setSort] = useState<SortKey>("cost");
  const [statuses, setStatuses] = useState<KeyStatus[]>(DEFAULT_KEY_STATUSES);
  const phone = useMediaQuery(PHONE_QUERY);
  const shown = rows.filter((r) => statuses.includes(statusOf(r.key_id)));
  const sorted = [...shown].sort((a, b) => b[sort] - a[sort]);

  if (state !== "ready") {
    return (
      <Card title="Usage by key">
        <PanelPlaceholder state={state} className="h-40" />
      </Card>
    );
  }

  const header = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => setSort(key)}
      className={`inline-flex min-h-7 items-center font-medium ${sort === key ? "text-brand-text" : "text-fg-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  const ariaSort = (key: SortKey) => (sort === key ? ("descending" as const) : undefined);
  const statusNote = (id: number) =>
    statusOf(id) !== "active" && <span className="ml-2 text-xs font-normal capitalize text-fg-muted">{statusOf(id)}</span>;
  const empty = rows.length === 0 ? "No usage in this range yet" : "No keys with these statuses in this range";

  return (
    <Card title="Usage by key" right={<KeyStatusFilter value={statuses} onChange={setStatuses} />}>
      {phone ? (
        <div>
          <SegmentedControl label="Sort keys by" options={SORTS} value={sort} onChange={setSort} className="mb-3" />
          {sorted.length === 0 && <p className="py-8 text-center text-sm text-fg-subtle">{empty}</p>}
          <ul className="divide-y divide-line">
            {sorted.map((r) => (
              <li key={r.key_id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="break-words font-medium text-fg">
                      {r.label}
                      {statusNote(r.key_id)}
                    </div>
                    <div className="font-mono text-xs text-fg-muted">{r.key_prefix}…</div>
                  </div>
                  <div className="shrink-0 text-right font-medium tabular-nums text-fg">
                    <CostCell cost={r.cost} requests={r.requests} unpriced={r.unpriced_requests} />
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-ui text-fg-muted">
                  <span>{num(r.requests)} requests</span>
                  <span>{tokens(r.total_tokens)} tokens</span>
                  <span>Last used {relTime(r.last_used_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" tabIndex={0} role="region" aria-label="Usage by key table">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-meta uppercase tracking-wide text-fg-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Key</th>
                <th scope="col" aria-sort={ariaSort("requests")} className="py-2 pr-4 text-right">{header("requests", "Requests")}</th>
                <th scope="col" aria-sort={ariaSort("total_tokens")} className="py-2 pr-4 text-right">{header("total_tokens", "Tokens")}</th>
                <th scope="col" aria-sort={ariaSort("cost")} className="py-2 pr-4 text-right">{header("cost", "Cost")}</th>
                <th scope="col" className="py-2 pr-0 text-right font-medium">Last used</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-fg-subtle">
                    {empty}
                  </td>
                </tr>
              )}
              {sorted.map((r) => (
                <tr key={r.key_id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4">
                    <div className="max-w-[18rem] truncate font-medium text-fg" title={r.label}>
                      {r.label}
                      {statusNote(r.key_id)}
                    </div>
                    <div className="font-mono text-xs text-fg-muted">{r.key_prefix}…</div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(r.requests)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{tokens(r.total_tokens)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums font-medium">
                    <CostCell cost={r.cost} requests={r.requests} unpriced={r.unpriced_requests} />
                  </td>
                  <td className="py-2 pr-0 text-right text-ui text-fg-muted">
                    {relTime(r.last_used_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
