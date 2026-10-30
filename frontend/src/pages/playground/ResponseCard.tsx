import { Link } from "react-router-dom";
import type { ChatResult } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { buttonClass } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/CopyButton";
import { num, providerName, usd } from "../../lib/format";

/** What the cost figure is: the provider's real charge, or our own calculation. Never a bare number. */
function CostSource({ source }: { source: ChatResult["cost_source"] }) {
  if (source === "provider")
    return (
      <Badge variant="success" dot title="The provider reported the real charge for this call.">
        Actual charge
      </Badge>
    );
  if (source === "workspace")
    return (
      <Badge title="Calculated from tokens and your workspace's own price.">Your price</Badge>
    );
  if (source === "configured")
    return (
      <Badge title="Calculated from tokens and our price table. It is not billed by the provider.">Estimated</Badge>
    );
  return null;
}

function Metric({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-meta font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="mt-1 font-semibold text-fg">{children}</dd>
    </div>
  );
}

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

/** One response: the text first, with Copy and a way to see the request in the log, then what it cost. */
export function ResponseCard({
  result,
  latest,
  keyId,
}: {
  result: ChatResult;
  /** the newest response is "Response"; older ones are named so the headings are not identical */
  latest: boolean;
  /** the key's id, when known, so "View in Requests" can filter to it */
  keyId?: number;
}) {
  const r = result;
  return (
    <section aria-label={latest ? "Response" : "Earlier response"} className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-fg">{latest ? "Response" : "Earlier response"}</h2>
          <Badge variant="success" dot>
            Success
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton label="Copy response" what="Response" text={r.response} />
          <Link
            to={keyId != null ? `/requests?key_id=${keyId}` : "/requests"}
            className={buttonClass("secondary", "sm")}
            title="The newest requests are at the top of the list"
          >
            View in Requests <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-fg">{r.response}</p>
      </div>
      <dl className="grid grid-cols-2 border-t border-line md:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
        <Metric label="Model" className="col-span-2 min-w-0 px-5 py-3 md:col-span-1">
          <span className="break-all font-mono text-[13px] font-normal">
            {r.provider}/{r.model}
          </span>
          <span className="sr-only"> ({providerName(r.provider)})</span>
        </Metric>
        <Metric label="Latency" className="border-t border-line px-5 py-3 md:border-l md:border-t-0">
          {seconds(r.latency_ms)}
        </Metric>
        <Metric label="Tokens" className="border-t border-line border-l px-5 py-3 md:border-t-0">
          <span title={`${num(r.usage.prompt_tokens)} prompt, ${num(r.usage.completion_tokens)} completion, ${num(r.usage.total_tokens)} total`}>
            {num(r.usage.prompt_tokens)} <span aria-hidden="true">→</span>
            <span className="sr-only"> prompt, </span> {num(r.usage.completion_tokens)}
            <span className="sr-only"> completion</span>
          </span>
        </Metric>
        <Metric label="Cost" className="col-span-2 border-t border-line px-5 py-3 md:col-span-1 md:border-l md:border-t-0">
          {r.cost == null ? (
            <span className="font-normal text-fg-muted" title="This model has no price in the catalog yet, so no cost can be shown.">
              No price yet
            </span>
          ) : (
            <span className="text-xl tabular-nums">{usd(r.cost)}</span>
          )}{" "}
          <CostSource source={r.cost_source} />
        </Metric>
      </dl>
    </section>
  );
}
