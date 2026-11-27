import { useEffect, useState } from "react";
import { api, type GuardrailHit, type RequestRow } from "../../lib/api";

/** What the content rules found in one request, loaded once for the whole inspector (the Content rules card and the
 *  highlighting in the prompt both use it). */
export type HitsState =
  | { status: "off" } // not a request a rule matched: nothing to load
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; hits: GuardrailHit[]; days: number };

type Loaded = { id: number; state: HitsState };

// constants, so a component that waits on the state sees the same object until something really changes
const OFF: HitsState = { status: "off" };
const LOADING: HitsState = { status: "loading" };

export function useGuardrailHits(row: Pick<RequestRow, "id" | "guardrail">): HitsState {
  const wants = row.guardrail === "blocked" || row.guardrail === "flagged";
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!wants) return;
    let cancelled = false;
    api.guardrails
      .hitItems(row.id)
      .then((r) => {
        // the API is newest first; show them in the order they were found
        if (!cancelled) setLoaded({ id: row.id, state: { status: "ready", hits: [...r.items].reverse(), days: r.retention_days } });
      })
      .catch((e: Error) => !cancelled && setLoaded({ id: row.id, state: { status: "error", message: e.message } }));
    return () => {
      cancelled = true;
    };
  }, [row.id, wants]);

  if (!wants) return OFF;
  // an answer for another request (the admin stepped to the next one) is not an answer for this one
  return loaded && loaded.id === row.id ? loaded.state : LOADING;
}
