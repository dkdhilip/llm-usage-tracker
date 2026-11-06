import { useEffect, useState } from "react";
import { api, type GuardrailHit, type RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Snippet } from "../workspace/guardrails/Snippet";
import { Section } from "./content";

const EXPLAIN: Record<NonNullable<RequestRow["guardrail"]>, string> = {
  blocked: "A content rule stopped this request before it reached the provider. The caller received a 403.",
  flagged: "A content rule matched, and the request was allowed through.",
  unchecked: "The content rules could not all be applied to this request (for example it was very large, or a rule took too long), so it went through without being fully checked.",
};

/** The request inspector's "Content rules" section: what happened, which rules matched, and the short redacted
 *  context around each match with the matched words highlighted (kept for word/phrase rules only). Matches are kept
 *  for a limited time, then deleted. */
export function GuardrailSection({ row }: { row: RequestRow }) {
  const [hits, setHits] = useState<GuardrailHit[] | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);
  const wantsHits = row.guardrail === "blocked" || row.guardrail === "flagged";

  useEffect(() => {
    setHits(null);
    setErr(null);
    if (!wantsHits) return;
    let cancelled = false;
    api.guardrails
      .hitItems(row.id)
      .then((r) => {
        if (cancelled) return;
        setHits([...r.items].reverse()); // the API is newest first; show them in the order they were found
        setDays(r.retention_days);
      })
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [row.id, wantsHits]);

  if (!row.guardrail) return null;
  return (
    <Section title="Content rules">
      <p className="text-sm text-fg" data-testid="guardrail-explain">
        {EXPLAIN[row.guardrail]}
      </p>
      {wantsHits && err && <p className="mt-2 text-sm text-danger-fg">Couldn't load the matches: {err}</p>}
      {wantsHits && !err && hits === null && <p className="mt-2 text-sm text-fg-muted">Loading matches…</p>}
      {hits && hits.length === 0 && (
        <p className="mt-2 text-sm text-fg-muted">
          The details of this match are no longer available (they are deleted after {days} days) or could not be recorded.
        </p>
      )}
      {hits && hits.length > 0 && (
        <ul className="mt-3 space-y-3" aria-label="Rules that matched">
          {hits.map((h) => (
            <li key={h.id} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{h.rule_name}</span>
                <Badge variant={h.action === "block" ? "danger" : "warning"}>{h.action === "block" ? "Block" : "Flag"}</Badge>
                <span className="text-xs text-fg-muted">in {h.rule_set_name}</span>
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                {h.occurrences} match{h.occurrences === 1 ? "" : "es"}
                {h.source_role ? ` · in the ${h.source_role} text` : ""}
              </div>
              {h.snippet ? (
                <blockquote className="mt-2 break-words rounded bg-surface-2 p-2 font-mono text-xs text-fg">
                  <Snippet snippet={h.snippet} match={h.matched_text} />
                </blockquote>
              ) : (
                <p className="mt-2 text-xs text-fg-muted">Context isn't shown for this match (it may contain a secret, or couldn't be located reliably).</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {wantsHits && hits && hits.length > 0 && (
        <p className="mt-3 text-xs text-fg-muted">
          Only admins can see this. The prompt of a flagged or blocked request is kept (encrypted) even when prompt
          logging is off, with credentials masked; a request that matched a card, key or email detector keeps no prompt,
          and a pattern match is shown as [matched]. Matches and their prompts are deleted after {days} days.
        </p>
      )}
    </Section>
  );
}
