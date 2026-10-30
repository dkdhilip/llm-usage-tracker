import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type ChatResult, type KeyInspect, type ModelInfo } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { CheckIcon } from "../components/ui/icons";
import { providerName } from "../lib/format";
import { CostWarning } from "./playground/CostWarning";
import { ResponseCard } from "./playground/ResponseCard";

const DEFAULT_PROMPT =
  "In two sentences, explain what an LLM gateway does and why usage tracking matters.";

const FIELD =
  "mt-1.5 w-full rounded-md border border-control bg-surface px-2.5 py-1.5 text-sm text-fg disabled:bg-fill disabled:text-fg-muted";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Sent {
  result: ChatResult;
  keyId?: number;
}

export function Playground() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [key, setKey] = useState("");
  const [inspect, setInspect] = useState<KeyInspect | null>(null);
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [results, setResults] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  // look up the key's allowed providers whenever it changes (debounced)
  useEffect(() => {
    const k = key.trim();
    setInspect(null);
    setKeyError(null);
    if (!k) {
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(() => {
      api
        .inspectKey(k)
        .then((r) => {
          setInspect(r);
          setProvider((prev) =>
            r.providers.some((p) => p.provider === prev)
              ? prev
              : (r.providers[0]?.provider ?? ""),
          );
        })
        .catch((e: Error) => setKeyError(e.message))
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(t);
  }, [key]);

  const providerModels = useMemo(
    () => models.filter((m) => m.provider === provider),
    [models, provider],
  );

  useEffect(() => {
    if (providerModels.length && !providerModels.some((m) => m.model === model)) {
      setModel(providerModels[0].model);
    }
  }, [providerModels, model]);

  const currentProvider = inspect?.providers.find((p) => p.provider === provider);

  let blockReason = "";
  if (inspect && currentProvider) {
    if (!inspect.allow_live)
      blockReason = 'this key is paused — resume it on the Workspace page (Keys, "More actions")';
    else if (!currentProvider.ready)
      blockReason = `no ${provider} API key is configured for this workspace`;
  }

  const ready = Boolean(key.trim() && inspect && provider && model && prompt.trim() && !blockReason);

  // what stops Send, in words (shown under the button, and the button points at it)
  const why = !key.trim()
    ? "Paste a virtual key to start."
    : keyError
      ? "Fix the virtual key first."
      : !inspect
        ? "Checking the key…"
        : !prompt.trim()
          ? "Write a prompt."
          : "";

  async function send() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.proxyChat({ provider, model, prompt }, key.trim());
      setResults((r) => [{ result: res }, ...r]);
      setAnnounce(`Response received from ${providerName(res.provider)}`);
      // "View in Requests" filters to this key. The key check does not return its id, but names are unique in a
      // workspace, so look it up by name; if that fails the link still opens the (newest-first) list.
      const label = inspect?.label;
      api
        .listKeys()
        .then((keys) => {
          const id = keys.find((k) => k.label === label && !k.revoked_at)?.id;
          if (id != null) setResults((r) => r.map((s) => (s.result === res ? { ...s, keyId: id } : s)));
        })
        .catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function paste() {
    setPasteNote(null);
    try {
      setKey((await navigator.clipboard.readText()).trim());
      keyInput.current?.focus();
    } catch {
      setPasteNote("Couldn't read the clipboard. Paste into the field with Ctrl+V instead.");
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div>
      <PageHeader title="Playground" description="Send a real request through your gateway with a virtual key." />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section aria-label="Send a request" onKeyDown={onKeyDown} className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm">
          <div>
            <label htmlFor="pg-key" className="text-ui font-medium text-fg">
              Virtual key
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="pg-key"
                ref={keyInput}
                className="min-w-0 flex-1 rounded-md border border-control bg-surface px-2.5 py-1.5 font-mono text-[13px] text-fg"
                placeholder="vk_…  (create one on the Workspace page)"
                value={key}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={keyError ? true : undefined}
                aria-describedby={keyError ? "key-error" : "key-status"}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button aria-label="Paste virtual key from clipboard" onClick={paste}>
                Paste
              </Button>
            </div>
            {pasteNote && <p className="mt-1.5 text-ui text-fg-muted">{pasteNote}</p>}
            <div id="key-status" role="status" className="mt-1.5 text-ui">
              {checking && !keyError && <span className="text-fg-muted">Checking the key…</span>}
              {inspect && !checking && (
                <span className={`inline-flex items-center gap-1.5 font-medium ${inspect.allow_live ? "text-success-fg" : "text-warning-fg"}`}>
                  <CheckIcon size={14} />
                  {inspect.label} · {inspect.providers.length} provider{inspect.providers.length === 1 ? "" : "s"} allowed
                  {inspect.allow_live ? "" : " · paused"}
                </span>
              )}
            </div>
            {keyError && (
              <InlineAlert id="key-error" tone="error" className="mt-1.5">
                {keyError}
              </InlineAlert>
            )}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <label className="block min-w-0 text-ui font-medium text-fg">
              Provider
              <select className={FIELD} value={provider} disabled={!inspect} onChange={(e) => setProvider(e.target.value)}>
                {!inspect && <option value="">enter a key first</option>}
                {inspect?.providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {providerName(p.provider)}
                    {p.ready ? "" : " · no key"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0 text-ui font-medium text-fg">
              Model
              <select className={FIELD} value={model} disabled={!providerModels.length} onChange={(e) => setModel(e.target.value)}>
                {providerModels.map((m) => (
                  <option key={m.model}>{m.model}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-ui font-medium text-fg">
            Prompt
            <textarea className={`${FIELD} h-36 resize-y`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>

          {blockReason && <InlineAlert tone="warning">Can't send: {blockReason}.</InlineAlert>}
          <CostWarning />

          <div>
            {/* aria-disabled, not disabled: pressing Send must not drop the keyboard user's place while it works */}
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              aria-disabled={busy || !ready || undefined}
              aria-busy={busy}
              aria-describedby={why ? "send-why" : undefined}
              onClick={send}
            >
              {busy ? "Sending…" : "Send request"}
              {!busy && (
                <span aria-hidden="true" className="ml-1.5 text-xs font-normal opacity-85">
                  {isMac ? "⌘ ↵" : "Ctrl ↵"}
                </span>
              )}
            </Button>
            {why && (
              <p id="send-why" className="mt-1.5 text-center text-ui text-fg-muted">
                {why}
              </p>
            )}
          </div>

          {error && <InlineAlert tone="error">{error}</InlineAlert>}
        </section>

        <div className="space-y-4">
          {results.length === 0 && (
            <div className="rounded-xl border border-dashed border-line bg-surface">
              <EmptyState
                title="Your response will appear here."
                description="Paste a virtual key, pick a provider and model, and send a request."
              />
            </div>
          )}
          {results.map((s, i) => (
            <ResponseCard key={s.result.request_id} result={s.result} latest={i === 0} keyId={s.keyId} />
          ))}
          <div role="status" className="sr-only">
            {announce}
          </div>
        </div>
      </div>
    </div>
  );
}
