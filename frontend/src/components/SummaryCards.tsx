import type { ReactNode } from "react";
import type { UsageSummary } from "../lib/api";
import { cn } from "../lib/cn";
import { costLabel, num, tokens, usd } from "../lib/format";
import { AlertIcon } from "./ui/icons";

/** How a figure moved against the period before: "Up 12%", "Down 8%" or "No change". Nothing (null) when there is no
 *  earlier figure to compare with (zero or missing), because a percentage of zero means nothing. */
export function trendOf(now: number, before: number): { dir: "up" | "down" | "flat"; text: string } | null {
  if (!(before > 0)) return null;
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 0.5) return { dir: "flat", text: "No change" };
  const shown = Math.abs(pct) > 999 ? "999%+" : `${Math.round(Math.abs(pct))}%`;
  return pct > 0 ? { dir: "up", text: `Up ${shown}` } : { dir: "down", text: `Down ${shown}` };
}

const ARROW = { up: "↑", down: "↓", flat: "→" } as const;

/** The movement line under a figure. Words and an arrow, in a neutral colour: more cost or traffic is not "bad" and
 *  less is not "good", so red and green would say something this page does not know. */
function Trend({ value, label }: { value: { dir: "up" | "down" | "flat"; text: string }; label: string }) {
  return (
    <div className="mt-0.5 text-ui tabular-nums text-fg-muted" data-testid="trend">
      <span aria-hidden="true">{ARROW[value.dir]}</span> <span className="font-medium text-fg">{value.text}</span> vs {label}
    </div>
  );
}

function Stat({
  label,
  value,
  trend,
  sub,
  lead,
  className,
}: {
  label: string;
  value: string;
  /** how it moved against the period before (see Trend) */
  trend?: ReactNode;
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
      <div className={cn("mt-1.5 font-semibold tabular-nums tracking-tight text-fg", lead ? "text-kpi-lg" : "text-kpi")}>{value}</div>
      {trend}
      {sub && <div className="mt-1 text-ui text-fg-muted">{sub}</div>}
    </div>
  );
}

/** The cost card, first and largest. Requests with no price add nothing to the total, so the card says how many there
 *  are (and that the real total is higher) rather than letting a low or $0 total read as the whole truth. */
function CostStat({ data, trend }: { data: UsageSummary; trend?: ReactNode }) {
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
      trend={trend}
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
  previous,
  loading,
  error,
}: {
  data: UsageSummary | null;
  /** The period just before this one (same length), for the "vs previous" lines. Optional. */
  previous?: { summary: UsageSummary; label: string } | null;
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
              "h-[124px] animate-pulse rounded-xl border border-line bg-surface motion-reduce:animate-none",
              i === 0 && "col-span-2 lg:col-span-1",
            )}
          />
        ))}
      </div>
    );
  }
  const prev = previous?.summary;
  const move = (now: number, before: number | undefined) => {
    const v = before === undefined ? null : trendOf(now, before);
    return v && previous ? <Trend value={v} label={previous.label} /> : undefined;
  };
  // A cost with unpriced requests in either period is only part of the truth, so it gets no percentage.
  const costComparable = !!prev && (data.unpriced_requests ?? 0) === 0 && (prev.unpriced_requests ?? 0) === 0;
  return (
    <div className={grid}>
      <CostStat data={data} trend={costComparable ? move(data.total_cost, prev?.total_cost) : undefined} />
      <Stat
        label="Requests"
        value={num(data.total_requests)}
        trend={move(data.total_requests, prev?.total_requests)}
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
        trend={move(data.total_tokens, prev?.total_tokens)}
        sub={`${num(data.total_prompt_tokens)} in · ${num(data.total_completion_tokens)} out`}
      />
      <Stat label="Active keys" value={num(data.active_keys)} sub="Not revoked" />
    </div>
  );
}
