import { costLabel } from "../lib/format";
import { Badge } from "./ui/Badge";

/** A cost total that never passes "no price" off as $0: an unknown cost says so, a free one says "Free", and a
 *  partly priced one shows the amount with how many requests are missing a price. */
export function CostCell({ cost, requests, unpriced }: { cost: number; requests: number; unpriced?: number }) {
  const c = costLabel(cost, requests, unpriced);
  return (
    <span title={c.title} className={c.unknown ? "font-normal text-fg-muted" : undefined}>
      {c.text}
      {c.note && <Badge variant="warning" className="ml-1.5 align-middle">{c.note}</Badge>}
    </span>
  );
}
