import { costLabel } from "../lib/format";
import { Badge } from "./ui/Badge";

/** A cost total that never passes "no price" off as $0: an unknown cost says so, a free one says "Free", and a
 *  partly priced one shows the amount with how many requests are missing a price.
 *  `short` shows whole cents (the exact amount is in the tooltip). `stacked` puts the "+N unpriced" note under the
 *  amount instead of beside it, so the amounts of every row end at the same edge in a right-aligned column. */
export function CostCell({
  cost,
  requests,
  unpriced,
  short,
  stacked,
}: {
  cost: number;
  requests: number;
  unpriced?: number;
  short?: boolean;
  stacked?: boolean;
}) {
  const c = costLabel(cost, requests, unpriced, short);
  const note = c.note && <Badge variant="warning" className={stacked ? "mt-0.5" : "ml-1.5 align-middle"}>{c.note}</Badge>;
  if (stacked) {
    return (
      <span title={c.title} className="inline-flex flex-col items-end">
        <span className={c.unknown ? "font-normal text-fg-muted" : undefined}>{c.text}</span>
        {note}
      </span>
    );
  }
  return (
    <span title={c.title} className={c.unknown ? "font-normal text-fg-muted" : undefined}>
      {c.text}
      {note}
    </span>
  );
}
