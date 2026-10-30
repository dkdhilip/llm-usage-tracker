import { Link } from "react-router-dom";
import type { RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScrollRegion } from "../../components/ui/ScrollRegion";
import { Skeleton } from "../../components/ui/Skeleton";
import { cn } from "../../lib/cn";
import { num, relTime } from "../../lib/format";
import { ProviderDot, RowCost, StatusBadge, seconds } from "./parts";

const TH = "sticky top-0 z-10 bg-surface py-2 pr-3 text-left text-meta font-medium uppercase tracking-wide text-fg-muted";

function ContentMarker() {
  return (
    <Badge className="ml-2 align-middle" title="The prompt and response are stored for this request">
      Content
    </Badge>
  );
}

/** What to show instead of rows: loading placeholders, the error (announced elsewhere), or an honest empty result. */
function Empty({ loading, error, hasFilters }: { loading: boolean; error: boolean; hasFilters: boolean }) {
  if (loading && !error) {
    return (
      <div className="space-y-2 py-2" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (error) return <p className="py-8 text-center text-sm text-fg-muted">Couldn't load requests.</p>;
  if (hasFilters) return <EmptyState title="No requests match these filters." description="Try a wider date range, or clear the filters." />;
  return (
    <EmptyState
      title="No requests yet."
      description="Point your app at the gateway and its calls will appear here."
      action={
        <Link to="/workspace" className={buttonClass("secondary", "md")}>
          See how to connect an app
        </Link>
      }
    />
  );
}

export function RequestList({
  rows,
  selectedId,
  phone,
  showTokens,
  constrain,
  loading,
  error,
  hasFilters,
  more,
  onOpen,
  onLoadMore,
}: {
  rows: RequestRow[];
  selectedId: number | null;
  phone: boolean;
  /** the Tokens column makes way for the inspector while one is open */
  showTokens: boolean;
  /** scroll inside the list (with a sticky header) so it can sit beside a sticky inspector */
  constrain: boolean;
  loading: boolean;
  error: boolean;
  hasFilters: boolean;
  more: boolean;
  onOpen: (row: RequestRow) => void;
  onLoadMore: () => void;
}) {
  const empty = rows.length === 0;
  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm">
      <div className="p-3">
        {empty ? (
          <Empty loading={loading} error={error} hasFilters={hasFilters} />
        ) : phone ? (
          <ul className="divide-y divide-line" aria-label="Requests">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  data-request-row={r.id}
                  onClick={() => onOpen(r)}
                  className="block min-h-11 w-full py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-fg">
                      <ProviderDot provider={r.provider} />
                      {r.model}
                    </span>
                    <StatusBadge status={r.status} />
                  </span>
                  <span className="mt-0.5 block text-sm text-fg-muted">
                    {r.key_label} · {relTime(r.ts)}
                    {r.has_content && <ContentMarker />}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm text-fg">
                    <span>{num(r.total_tokens)} tokens</span>
                    <span>{seconds(r.latency_ms)}</span>
                    <RowCost row={r} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ScrollRegion label="Request log table" className={cn(constrain && "max-h-[calc(100vh-14rem)] overflow-y-auto")}>
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={TH}>When</th>
                  <th scope="col" className={TH}>Key</th>
                  <th scope="col" className={TH}>Model</th>
                  <th scope="col" className={TH}>Status</th>
                  {showTokens && <th scope="col" className={cn(TH, "text-right")}>Tokens</th>}
                  <th scope="col" className={cn(TH, "text-right")}>Latency</th>
                  <th scope="col" className={cn(TH, "pr-0 text-right")}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const selected = r.id === selectedId;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      data-request-row={r.id}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => onOpen(r)}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          onOpen(r);
                        }
                      }}
                      className={cn(
                        "cursor-pointer border-b border-line last:border-0 hover:bg-fill",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text",
                        selected && "bg-brand-soft",
                      )}
                    >
                      <td className="whitespace-nowrap py-2 pr-3 text-fg-muted" title={new Date(r.ts).toLocaleString()}>
                        {relTime(r.ts)}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        {r.key_label}
                        {r.has_content && <ContentMarker />}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        <ProviderDot provider={r.provider} />
                        <span className="font-mono text-xs">{r.model}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={r.status} />
                      </td>
                      {showTokens && <td className="py-2 pr-3 text-right tabular-nums">{num(r.total_tokens)}</td>}
                      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{seconds(r.latency_ms)}</td>
                      <td className="whitespace-nowrap py-2 text-right tabular-nums">
                        <RowCost row={r} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </div>
      {!empty && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5 text-sm text-fg-muted">
          <span>
            Showing {num(rows.length)} request{rows.length === 1 ? "" : "s"}
            {more ? "" : " · that's all of them"}
          </span>
          {more && (
            <Button size="sm" aria-busy={loading} onClick={() => !loading && onLoadMore()}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
