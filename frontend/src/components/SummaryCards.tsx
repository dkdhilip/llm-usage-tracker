import type { ReactNode } from "react";
import type { UsageSummary } from "../lib/api";
import { cn } from "../lib/cn";
import { costLabel, num, tokens, usd } from "../lib/format";
import { AlertIcon } from "./ui/icons";

function Stat({
  label,
  value,
  sub,
  lead,
  className,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  /** the headline figure: the largest, and set apart by an accent edge */
  lead?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface p-4 shadow-sm",
        lead && "border-l-[3px] border-l-brand-600",
        className,
      )}
    >
      <div className="text-meta font-medium uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={cn("mt-1.5 font-semibold tabular-nums text-fg", lead ? "text-kpi-lg" : "text-kpi")}>{value}</div>
      {sub && <div className="mt-1 text-ui text-fg-muted">{sub}</div>}
    </div>
  );
}

/** The cost card, first and largest. Requests with no price add nothing to the total, so the card says how many there
 *  are (and that the real total is higher) rather than letting a low or $0 total read as the whole truth. */
function CostStat({ data }: { data: UsageSummary }) {
  const c = costLabel(data.total_cost, data.total_requests, data.unpriced_requests);
  const unpriced = data.unpriced_requests ?? 0;
  const base =
    data.cost_actual > 0
      ? `${usd(data.cost_actual)} actual · ${usd(data.cost_estimated)} est.`
      : "estimated from configured pricing";
  const warn = (text: string) => (
    <span className="mt-1 flex items-start gap-1.5 text-warning-fg">
      <AlertIcon className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </span>
  );
  return (
    <Stat
      lead
      className="col-span-2 lg:col-span-1"
      label={data.cost_actual > 0 ? "Cost" : "Estimated cost"}
      value={data.total_requests === 0 ? "$0.00" : c.text}
      sub={
        c.unknown ? (
          warn(`${num(data.total_requests)} requests have no price yet`)
        ) : unpriced > 0 ? (
          <>
            {base}
            {warn(`${num(unpriced)} request${unpriced === 1 ? " has" : "s have"} no price yet, so the real total is higher`)}
          </>
        ) : (
          base
        )
      }
    />
  );
}

/** The share of requests that did not fail, never rounded up to 100% while an error exists. */
export function successRate(total: number, errors: number): string {
  if (total <= 0) return "—";
  const pct = Math.floor(((total - errors) / total) * 1000) / 10;
  return `${pct.toFixed(1)}%`;
}

export function SummaryCards({
  data,
  loading,
  error,
}: {
  data: UsageSummary | null;
  loading: boolean;
  /** The data failed to load: show dashes, not zeros (zero would read as "no usage"). */
  error?: boolean;
}) {
  const grid = "grid grid-cols-2 gap-4 lg:grid-cols-[1.5fr_1fr_1fr_1fr]";
  if (error) {
    return (
      <div className={grid}>
        {["Estimated cost", "Requests", "Tokens", "Active keys"].map((l, i) => (
          <Stat key={l} label={l} value="—" lead={i === 0} className={i === 0 ? "col-span-2 lg:col-span-1" : undefined} />
        ))}
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className={grid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-[104px] animate-pulse rounded-xl border border-line bg-surface motion-reduce:animate-none",
              i === 0 && "col-span-2 lg:col-span-1",
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={grid}>
      <CostStat data={data} />
      <Stat
        label="Requests"
        value={num(data.total_requests)}
        sub={
          data.total_requests === 0
            ? undefined
            : data.errors > 0
              ? `${num(data.errors)} error${data.errors === 1 ? "" : "s"} · ${successRate(data.total_requests, data.errors)} success`
              : "No errors"
        }
      />
      <Stat
        label="Tokens"
        value={tokens(data.total_tokens)}
        sub={`${num(data.total_prompt_tokens)} in · ${num(data.total_completion_tokens)} out`}
      />
      <Stat label="Active keys" value={num(data.active_keys)} />
    </div>
  );
}
