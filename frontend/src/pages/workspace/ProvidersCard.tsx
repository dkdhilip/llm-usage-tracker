import { useState } from "react";
import { api, type WorkspaceProvider } from "../../lib/api";
import { Card } from "../../components/Card";
import { providerName, usd } from "../../lib/format";

// ---------- provider keys + caps ----------
export function ProviderRow({
  p,
  defaultCap,
  onChange,
}: {
  p: WorkspaceProvider;
  defaultCap: number;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(p.source === "none");
  // With no key saved the entry field is ALWAYS shown. (It used to depend on `editing`, which was only true if the
  // row had started without a key, so after clearing a saved key the field stayed hidden until a page refresh.)
  const showInput = editing || p.source === "none";
  const [val, setVal] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState<null | "key" | "cap">(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (kind: "key" | "cap", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const effCap = p.monthly_cap_usd ?? defaultCap;
  const over = p.spend_this_month >= effCap;

  return (
    <li className="space-y-1.5 border-b border-line pb-2 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">{providerName(p.provider)}</span>
        {p.source === "env" ? (
          <span className="ml-auto rounded bg-fill px-1.5 py-0.5 text-[10px] text-fg-muted">
            set via server env
          </span>
        ) : (
          <div className="ml-auto flex items-center gap-1.5">
            {p.source === "workspace" && !showInput && (
              <>
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                  saved ····{p.last4}
                </span>
                <button
                  aria-label={`Replace ${providerName(p.provider)} key`}
                  className="text-[11px] text-brand-600 hover:underline inline-flex min-h-7 items-center"
                  onClick={() => setEditing(true)}
                >
                  replace
                </button>
                <button
                  aria-label={`Clear ${providerName(p.provider)} key`}
                  className="text-[11px] text-danger-fg hover:underline disabled:opacity-50 inline-flex min-h-7 items-center"
                  disabled={busy !== null}
                  onClick={() => run("key", () => api.clearWorkspaceProviderKey(p.provider))}
                >
                  clear
                </button>
              </>
            )}
            {showInput && (
              <>
                <input
                  type="password"
                  placeholder={`paste ${p.provider} key`}
                  aria-label={`${providerName(p.provider)} API key`}
                  className="w-40 rounded border border-line px-1.5 py-1 min-h-7 text-[11px]"
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                />
                <button
                  aria-label={`Save ${providerName(p.provider)} key`}
                  className="rounded bg-brand-600 px-2 py-1 min-h-7 text-[10px] font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  disabled={busy !== null || val.trim().length < 8}
                  onClick={() =>
                    run("key", async () => {
                      await api.setWorkspaceProviderKey(p.provider, val.trim());
                      setVal("");
                      setEditing(false);
                    })
                  }
                >
                  save
                </button>
                {p.source === "workspace" && (
                  <button
                    className="text-[11px] text-fg-subtle hover:underline inline-flex min-h-7 items-center"
                    onClick={() => setEditing(false)}
                  >
                    cancel
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {p.source === "workspace" && (
        <div className="pl-0.5">
          <div className="flex justify-between text-[11px] text-fg-subtle">
            <span>live spend this month</span>
            <span>
              {usd(p.spend_this_month)} / {usd(effCap)}
            </span>
          </div>
          <div className="mt-1 h-1.5 rounded bg-fill">
            <div
              className={`h-1.5 rounded ${over ? "bg-red-500" : "bg-brand-500"}`}
              style={{
                width: `${Math.min(100, effCap > 0 ? (p.spend_this_month / effCap) * 100 : 100)}%`,
              }}
            />
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[11px] text-fg-muted">Monthly cap $</span>
            <input
              type="number"
              min="0"
              step="1"
              aria-label={`Monthly cap for ${providerName(p.provider)} in US dollars`}
              className="w-24 rounded-md border border-line px-2 py-1 min-h-7 text-[11px]"
              placeholder={
                p.monthly_cap_usd != null ? String(p.monthly_cap_usd) : `${defaultCap} (default)`
              }
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <button
              aria-label={`Set monthly cap for ${providerName(p.provider)}`}
              className="rounded-md border border-line px-2.5 py-1 min-h-7 text-[11px] text-fg-muted hover:bg-fill disabled:opacity-50"
              disabled={busy !== null || cap.trim() === ""}
              onClick={() =>
                run("cap", async () => {
                  await api.setWorkspaceProviderCap(p.provider, Number(cap));
                  setCap("");
                })
              }
            >
              set
            </button>
            {p.monthly_cap_usd != null && (
              <button
                className="text-[11px] text-brand-600 hover:underline disabled:opacity-50 inline-flex min-h-7 items-center"
                disabled={busy !== null}
                onClick={() => run("cap", () => api.setWorkspaceProviderCap(p.provider, null))}
              >
                use default
              </button>
            )}
          </div>
        </div>
      )}
      {err && <div className="text-[10px] text-red-600">{err}</div>}
    </li>
  );
}

export function ProvidersCard({
  providers,
  defaultCap,
  onChange,
}: {
  providers: WorkspaceProvider[];
  defaultCap: number;
  onChange: () => void;
}) {
  return (
    <Card title="Provider keys">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-fg-muted">
          Attach the workspace's own OpenAI / Anthropic / Gemini / OpenRouter key and set a
          monthly cap. Virtual keys for a configured provider hit the real provider on this key,
          up to its cap. Only the last 4 digits are shown back.
        </p>
        <ul className="space-y-2">
          {providers.map((p) => (
            <ProviderRow key={p.provider} p={p} defaultCap={defaultCap} onChange={onChange} />
          ))}
        </ul>
      </div>
    </Card>
  );
}
