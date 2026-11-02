import type { RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { AlertIcon } from "../../components/ui/icons";
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
  // Stopped before the provider was called. The word carries the meaning; the colour only reinforces it.
  if (status === "blocked")
    return (
      <Badge variant="danger" dot title="Stopped before the provider was called">
        Blocked
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
  // A blocked request never reached a provider, so nothing was charged: not "Free" (which means priced at $0).
  if (row.status === "blocked")
    return (
      <span className="text-fg-muted" title="Stopped before the provider was called, so nothing was charged">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not charged</span>
      </span>
    );
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

/** A request a content rule matched (it was blocked, or flagged): its row is tinted red, and says why in words. */
export const isRuleRow = (row: RequestRow) => row.guardrail === "blocked" || row.guardrail === "flagged";

const ruleNames = (row: RequestRow) => {
  const names = [...new Set((row.guardrail_rules ?? []).map((r) => r.rule_name))];
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
};

/** What the content rules did to this request, as text: the colour and the icon only reinforce it. A blocked request
 *  already says "Blocked" in its status, so this adds the rule; a flagged one says "Flagged"; one the rules could not
 *  fully check says so, because that is not the same as "nothing matched". */
export function GuardrailBadge({ row }: { row: RequestRow }) {
  if (row.guardrail === "blocked") {
    const names = ruleNames(row);
    return names ? <span className="mt-0.5 block text-xs text-danger-fg">Rule: {names}</span> : null;
  }
  if (row.guardrail === "flagged") {
    const names = ruleNames(row);
    return (
      <Badge variant="warning" className="mt-0.5" title="Allowed through, but a content rule matched">
        <AlertIcon className="h-3 w-3" />
        Flagged{names ? `: ${names}` : ""}
      </Badge>
    );
  }
  if (row.guardrail === "unchecked")
    return (
      <Badge className="mt-0.5" title="The content rules could not all be applied to this request, so it went through unchecked">
        Not fully checked
      </Badge>
    );
  return null;
}
