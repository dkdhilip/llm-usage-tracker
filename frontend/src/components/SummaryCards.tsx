import type { UsageSummary } from "../lib/api";
import { costLabel, num, tokens, usd } from "../lib/format";

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="mt-1 text-xs text-fg-subtle">{sub}</div>}
    </div>
  );
}

/** The cost card. Requests with no price add nothing to the total, so the card says how many there are rather than
 *  letting a low or $0 total read as the whole truth. */
function CostStat({ data }: { data: UsageSummary }) {
  const c = costLabel(data.total_cost, data.total_requests, data.unpriced_requests);
  const unpriced = data.unpriced_requests ?? 0;
  const base =
    data.cost_actual > 0
      ? `${usd(data.cost_actual)} actual · ${usd(data.cost_estimated)} est.`
      : "estimated from configured pricing";
  return (
    <Stat
      label="Cost"
      value={data.total_requests === 0 ? "$0.00" : c.text}
      sub={
        c.unknown
          ? `${num(data.total_requests)} requests have no price yet`
          : unpriced > 0
            ? `${base} · ${num(unpriced)} request${unpriced === 1 ? "" : "s"} have no price yet`
            : base
      }
    />
  );
}

export function SummaryCards({
  data,
  loading,
}: {
  data: UsageSummary | null;
  loading: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[92px] animate-pulse rounded-xl border border-line bg-surface"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat label="Total Requests" value={num(data.total_requests)} />
      <Stat
        label="Total Tokens"
        value={tokens(data.total_tokens)}
        sub={`${num(data.total_prompt_tokens)} in · ${num(data.total_completion_tokens)} out`}
      />
      <CostStat data={data} />
      <Stat label="Active Virtual Keys" value={num(data.active_keys)} />
    </div>
  );
}
