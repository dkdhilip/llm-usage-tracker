import { useState } from "react";
import { api, type WorkspaceProvider } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/ui/Field";
import { InlineAlert } from "../../components/ui/InlineAlert";
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
  const name = providerName(p.provider);

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
  const pct = effCap > 0 ? (p.spend_this_month / effCap) * 100 : 100;
  const over = pct >= 100;
  const warn = !over && pct >= 80;

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{name}</span>
        {p.source === "env" && <Badge>set via server env</Badge>}
        {p.source === "workspace" && !showInput && <Badge variant="success">saved ····{p.last4}</Badge>}
        {p.source === "none" && <Badge>No key yet</Badge>}
        {p.source === "workspace" && !showInput && (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label={`Replace ${name} key`} onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              size="sm"
              variant="danger"
              aria-label={`Clear ${name} key`}
              disabled={busy !== null}
              onClick={() => run("key", () => api.clearWorkspaceProviderKey(p.provider))}
            >
              Clear
            </Button>
          </div>
        )}
      </div>

      {showInput && p.source !== "env" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder={`paste ${p.provider} key`}
            aria-label={`${name} API key`}
            className="min-w-0 flex-1 sm:max-w-xs"
            value={val}
            onChange={(e) => setVal(e.target.value)}
          />
          <Button
            size="sm"
            variant="primary"
            aria-label={`Save ${name} key`}
            disabled={busy !== null || val.trim().length < 8}
            onClick={() =>
              run("key", async () => {
                await api.setWorkspaceProviderKey(p.provider, val.trim());
                setVal("");
                setEditing(false);
              })
            }
          >
            Save
          </Button>
          {p.source === "workspace" && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {p.source === "workspace" && (
        <div>
          <div className="flex justify-between gap-2 text-ui text-fg-muted">
            <span>Live spend this month</span>
            <span className={over ? "font-semibold text-danger-fg" : warn ? "font-semibold text-warning-fg" : undefined}>
              {usd(p.spend_this_month)} / {usd(effCap)}
              {over ? " · cap reached" : ""}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${name} spend this month`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(pct))}
            className="mt-1.5 h-1.5 overflow-hidden rounded bg-fill"
          >
            <div
              className={`h-full rounded ${over ? "bg-red-600" : warn ? "bg-amber-500" : "bg-brand-500"}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-ui text-fg-muted">Monthly cap $</span>
            <Input
              type="number"
              min="0"
              step="1"
              aria-label={`Monthly cap for ${name} in US dollars`}
              className="!w-28"
              placeholder={p.monthly_cap_usd != null ? String(p.monthly_cap_usd) : `${defaultCap} (default)`}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <Button
              size="sm"
              aria-label={`Set monthly cap for ${name}`}
              disabled={busy !== null || cap.trim() === ""}
              onClick={() =>
                run("cap", async () => {
                  await api.setWorkspaceProviderCap(p.provider, Number(cap));
                  setCap("");
                })
              }
            >
              Set
            </Button>
            {p.monthly_cap_usd != null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => run("cap", () => api.setWorkspaceProviderCap(p.provider, null))}
              >
                Use default
              </Button>
            )}
          </div>
        </div>
      )}
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
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
      <p className="mb-4 text-sm text-fg-muted">
        Attach the workspace's own OpenAI / Anthropic / Gemini / OpenRouter key and set a monthly cap. Virtual keys for a
        configured provider hit the real provider on this key, up to its cap. Only the last 4 digits are shown back.
      </p>
      <ul className="divide-y divide-line">
        {providers.map((p) => (
          <ProviderRow key={p.provider} p={p} defaultCap={defaultCap} onChange={onChange} />
        ))}
      </ul>
    </Card>
  );
}
