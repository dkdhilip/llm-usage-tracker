import type { RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { providerColor } from "../../lib/chartColors";
import { costSourceLabel, usd } from "../../lib/format";

/** Status as a word as well as a colour. */
export function StatusBadge({ status }: { status: string }) {
  if (status === "success")
    return (
      <Badge variant="success" dot>
        Success
      </Badge>
    );
  if (status === "error")
    return (
      <Badge variant="danger" dot>
        Error
      </Badge>
    );
  return (
    <Badge dot className="capitalize">
      {status}
    </Badge>
  );
}

/** One request's cost. No price is "No price yet", never $0; a real $0 is "Free". */
export function RowCost({ row, long }: { row: RequestRow; long?: boolean }) {
  if (row.cost == null) return <span className="text-fg-muted">No price yet</span>;
  if (row.cost === 0) return <span title="Priced at $0">Free</span>;
  return (
    <span title={costSourceLabel(row.cost_source, true)}>
      {usd(row.cost)}
      <span className="ml-1 text-meta text-fg-muted">{costSourceLabel(row.cost_source, long)}</span>
    </span>
  );
}

/** A provider's colour dot; the provider is always also named in text beside it. */
export function ProviderDot({ provider }: { provider: string }) {
  return <span className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: providerColor(provider) }} aria-hidden="true" />;
}

export function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
