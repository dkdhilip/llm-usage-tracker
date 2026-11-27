import type { RequestContent, RequestRow } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Mark, Snippet } from "../workspace/guardrails/Snippet";
import { Section, promptParts } from "./content";
import { sentenceForHit } from "./matches";
import type { HitsState } from "./useGuardrailHits";

const EXPLAIN: Record<NonNullable<RequestRow["guardrail"]>, string> = {
  blocked: "A content rule stopped this request before it reached the provider. The caller received a 403.",
  flagged: "A content rule matched, and the request was allowed through.",
  unchecked: "The content rules could not all be applied to this request (for example it was very large, or a rule took too long), so it went through without being fully checked.",
};

/** The request inspector's "Content rules" section: what happened, which rules matched, and the sentence each match sits
 *  in, with the matched words highlighted (a word or phrase rule; the same words are highlighted in the prompt below).
 *  The sentence comes from the stored prompt; when that is not there (it expired, or the words cannot be found in it)
 *  the short redacted context the server kept is shown instead. Matches are kept for a limited time, then deleted. */
export function GuardrailSection({
  row,
  hits: state,
  content,
  contentError,
}: {
  row: RequestRow;
  hits: HitsState;
  /** the stored prompt, once loaded (null while loading); the sentences are cut from it */
  content?: RequestContent | null;
  contentError?: string | null;
}) {
  if (!row.guardrail) return null;
  const wantsHits = state.status !== "off";
  // the sentences need the prompt: wait for it (or its failure) rather than show a short excerpt that is then replaced
  const waitingForPrompt = row.has_content === true && content == null && !contentError;
  const parts = content ? promptParts(content) : [];
  const hits = state.status === "ready" ? state.hits : null;
  const days = state.status === "ready" ? state.days : 30;
  return (
    <Section title="Content rules">
      <p className="text-sm text-fg" data-testid="guardrail-explain">
        {EXPLAIN[row.guardrail]}
      </p>
      {state.status === "error" && <p className="mt-2 text-sm text-danger-fg">Couldn't load the matches: {state.message}</p>}
      {(state.status === "loading" || (hits && hits.length > 0 && waitingForPrompt)) && (
        <p className="mt-2 text-sm text-fg-muted">Loading matches…</p>
      )}
      {hits && hits.length === 0 && (
        <p className="mt-2 text-sm text-fg-muted">
          The details of this match are no longer available (they are deleted after {days} days) or could not be recorded.
        </p>
      )}
      {hits && hits.length > 0 && !waitingForPrompt && (
        <ul className="mt-3 space-y-3" aria-label="Rules that matched">
          {hits.map((h) => {
            const sentence = sentenceForHit(h, parts);
            return (
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
                {sentence ? (
                  <blockquote className="mt-2 break-words rounded bg-surface-2 p-2 font-mono text-[13px] leading-5 text-fg" data-testid="matched-sentence">
                    {sentence.before}
                    <Mark>{sentence.match}</Mark>
                    {sentence.after}
                  </blockquote>
                ) : h.snippet ? (
                  <blockquote className="mt-2 break-words rounded bg-surface-2 p-2 font-mono text-xs text-fg">
                    <Snippet snippet={h.snippet} match={h.matched_text} />
                  </blockquote>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">Context isn't shown for this match (it may contain a secret, or couldn't be located reliably).</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {wantsHits && hits && hits.length > 0 && !waitingForPrompt && (
        <p className="mt-3 text-xs text-fg-muted">
          Only admins can see this. The prompt of a flagged or blocked request is kept (encrypted) even when prompt
          logging is off, with credentials masked; a request that matched a card, key or email detector keeps no prompt,
          and a pattern match is shown as [matched]. Matches and their prompts are deleted after {days} days.
        </p>
      )}
    </Section>
  );
}
