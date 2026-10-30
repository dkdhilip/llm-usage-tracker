import type { Ref } from "react";
import type { RequestContent, RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, XIcon } from "../../components/ui/icons";
import { num, providerName, relTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { CopyButton } from "../../components/ui/CopyButton";
import { Section, SectionLevel, StoredContentSections } from "./content";
import { ProviderDot, RowCost, StatusBadge, seconds } from "./parts";

const STEP = "aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

/** Previous / next request. They stay focusable at the ends (aria-disabled, not disabled) so a keyboard user who
 *  reaches the end does not lose their place. */
function StepButtons({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <IconButton size="sm" label="Previous request" title="Previous request (K)" aria-disabled={!hasPrev || undefined} className={STEP} onClick={() => hasPrev && onPrev()}>
        <ArrowUpIcon />
      </IconButton>
      <IconButton size="sm" label="Next request" title="Next request (J)" aria-disabled={!hasNext || undefined} className={STEP} onClick={() => hasNext && onNext()}>
        <ArrowDownIcon />
      </IconButton>
    </>
  );
}

function MetaBadges({ row }: { row: RequestRow }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <StatusBadge status={row.status} />
      <Badge>{seconds(row.latency_ms)}</Badge>
      <Badge>
        <RowCost row={row} long />
      </Badge>
      <Badge>{num(row.total_tokens)} tokens</Badge>
    </div>
  );
}

function Details({ row, content }: { row: RequestRow; content: RequestContent | null }) {
  const expires = content?.content_status === "available" && content.expires_at ? new Date(content.expires_at) : null;
  return (
    <Section title="Details">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-fg-muted">Time</dt>
        <dd>{new Date(row.ts).toLocaleString()}</dd>
        <dt className="text-fg-muted">Key</dt>
        <dd className="break-words">
          {row.key_label} <span className="font-mono text-xs text-fg-muted">{row.key_prefix}…</span>
        </dd>
        <dt className="text-fg-muted">Model</dt>
        <dd className="break-words">
          <ProviderDot provider={row.provider} />
          {providerName(row.provider)} · <span className="font-mono text-xs">{row.model}</span>
        </dd>
        <dt className="text-fg-muted">Tokens</dt>
        <dd>
          {num(row.prompt_tokens)} prompt · {num(row.completion_tokens)} completion · {num(row.total_tokens)} total
        </dd>
        <dt className="text-fg-muted">Cost</dt>
        <dd>
          <RowCost row={row} long />
        </dd>
        <dt className="text-fg-muted">Latency</dt>
        <dd>{seconds(row.latency_ms)}</dd>
        <dt className="text-fg-muted">Request ID</dt>
        <dd className="flex flex-wrap items-center gap-x-2">
          <span className="break-all font-mono text-xs">{row.request_id}</span>
          <CopyButton label="Copy ID" what="Request ID" text={row.request_id} variant="ghost" />
        </dd>
      </dl>
      {expires && (
        <p className="mt-3 text-xs text-fg-muted">
          Stored content is encrypted and will be deleted on {expires.toLocaleDateString()}.
        </p>
      )}
    </Section>
  );
}

/** Everything about one request: the prompt and response first (with Copy), then the facts. Shown beside the list on
 *  a wide screen ("pane") and as its own full-screen view, with a Back button, on a narrower one ("page"). */
export function RequestInspector({
  row,
  content,
  contentError,
  mode,
  headingRef,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  row: RequestRow;
  content: RequestContent | null;
  contentError: string | null;
  mode: "pane" | "page";
  headingRef: Ref<HTMLHeadingElement>;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const body = (
    <>
      {row.has_content && <StoredContentSections content={content} error={contentError} usageId={row.id} />}
      {/* The old LOG_BODIES previews: only shown when one actually exists (the flag is off in production). */}
      {(row.prompt_preview != null || row.response_preview != null) && (
        <Section title="Previews">
          <div className="space-y-3" data-testid="legacy-previews">
            {row.prompt_preview != null && (
              <div>
                <div className="text-xs font-medium text-fg-muted">Prompt preview</div>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-fg">{row.prompt_preview}</pre>
              </div>
            )}
            {row.response_preview != null && (
              <div>
                <div className="text-xs font-medium text-fg-muted">Response preview</div>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-fg">{row.response_preview}</pre>
              </div>
            )}
          </div>
        </Section>
      )}
      {!row.has_content && row.prompt_preview == null && row.response_preview == null && (
        <Section title="Prompt and response">
          <p className="text-sm text-fg-muted" data-testid="nothing-stored">
            No prompt or response was stored for this request.
          </p>
        </Section>
      )}
      <Details row={row} content={content} />
    </>
  );

  if (mode === "pane") {
    return (
      <aside
        aria-label="Request inspector"
        className="sticky top-2 max-h-[calc(100vh-1rem)] overflow-y-auto rounded-xl border border-line bg-surface shadow-sm"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-fg focus:outline-none">
              Request inspector
            </h2>
            <MetaBadges row={row} />
          </div>
          <div className="flex shrink-0 gap-1">
            <StepButtons hasPrev={hasPrev} hasNext={hasNext} onPrev={onPrev} onNext={onNext} />
            <IconButton size="sm" label="Close inspector" onClick={onClose}>
              <XIcon />
            </IconButton>
          </div>
        </div>
        <SectionLevel.Provider value={3}>{body}</SectionLevel.Provider>
      </aside>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" aria-label="Back to requests list" onClick={onClose}>
          <ArrowLeftIcon /> Requests
        </Button>
        <h1 ref={headingRef} tabIndex={-1} className="mx-auto text-base font-semibold text-fg focus:outline-none">
          Request
        </h1>
        <div className="flex gap-1">
          <StepButtons hasPrev={hasPrev} hasNext={hasNext} onPrev={onPrev} onNext={onNext} />
        </div>
      </div>
      <div className="mb-3 px-1">
        <div className="break-words font-semibold text-fg">
          <ProviderDot provider={row.provider} />
          {row.model}
        </div>
        <div className="text-sm text-fg-muted">
          {row.key_label} · {relTime(row.ts)}
        </div>
        <MetaBadges row={row} />
      </div>
      <section aria-label="Request details" className={cn("overflow-hidden rounded-xl border border-line bg-surface shadow-sm")}>
        <SectionLevel.Provider value={2}>{body}</SectionLevel.Provider>
      </section>
    </div>
  );
}
