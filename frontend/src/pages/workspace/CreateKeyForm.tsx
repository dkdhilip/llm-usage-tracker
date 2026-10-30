import { useCallback, useEffect, useState } from "react";
import { api, PROVIDERS, type BudgetPeriod, type KeyCreated } from "../../lib/api";
import { Card } from "../../components/Card";
import { ConnectPanel } from "../../components/ConnectPanel";
import { providerName } from "../../lib/format";

// ---------- create key ----------
export function CreateKeyForm({
  onCreated,
  configuredProviders,
  members,
  masterText,
  masterImages,
}: {
  onCreated: () => void;
  configuredProviders: string[];
  members: { user_id: number; username: string }[];
  masterText?: boolean;
  masterImages?: boolean;
}) {
  const [logText, setLogText] = useState(false);
  const [logImages, setLogImages] = useState(false);
  const [label, setLabel] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetPeriod, setBudgetPeriod] = useState<BudgetPeriod>("month");
  const [budgetStart, setBudgetStart] = useState("");
  const [budgetEnd, setBudgetEnd] = useState("");
  const [created, setCreated] = useState<KeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canPick = useCallback(
    (p: string) => configuredProviders.includes(p),
    [configuredProviders],
  );
  const picked = allowed.filter(canPick);
  const noneConfigured = configuredProviders.length === 0;
  const willBeLive = picked.length > 0;

  useEffect(() => {
    setAllowed((a) => {
      const kept = a.filter(canPick);
      if (kept.length) return kept.length === a.length ? a : kept;
      const first = PROVIDERS.find(canPick);
      return first ? [first] : a.length ? [] : a;
    });
  }, [canPick]);

  function toggle(p: string) {
    if (!canPick(p)) return;
    setAllowed((a) => (a.includes(p) ? a.filter((x) => x !== p) : [...a, p]));
  }

  async function submit() {
    setErr(null);
    try {
      const res = await api.createKey({
        label: label.trim(),
        allowed_providers: picked,
        allow_live: willBeLive,
        default_provider: picked.length === 1 ? picked[0] : null,
        assigned_user_id: assignee ? Number(assignee) : null,
        monthly_budget_usd: budget.trim() ? Number(budget) : null,
        budget_period: budgetPeriod,
        budget_start: budgetPeriod === "custom" ? budgetStart || null : null,
        budget_end: budgetPeriod === "custom" ? budgetEnd || null : null,
        content_logging_enabled: logText,
        image_logging_enabled: logText && logImages,
      });
      setCreated(res);
      setLogText(false);
      setLogImages(false);
      setCopied(false);
      setLabel("");
      setBudget("");
      setBudgetStart("");
      setBudgetEnd("");
      setAssignee("");
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Card title="Create a virtual key">
      <div className="space-y-3">
        <input
          className="w-full rounded-md border border-line px-3 py-2 text-sm"
          aria-label="Key label"
          placeholder="Label — e.g. Jane (Data Science) or Support Bot"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className="-mt-1 text-[11px] text-fg-subtle" data-testid="label-hint">
          Each active key needs its own name in this workspace, so you can tell who used what.
        </p>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Allowed providers
          </div>
          <div className="flex flex-wrap gap-3">
            {PROVIDERS.map((p) => {
              const ok = canPick(p);
              return (
                <label
                  key={p}
                  title={ok ? undefined : `No key configured for ${p}`}
                  className={`flex items-center gap-1.5 text-sm ${
                    ok ? "" : "cursor-not-allowed opacity-40"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={allowed.includes(p)}
                    disabled={!ok}
                    onChange={() => toggle(p)}
                  />
                  <span>{providerName(p)}</span>
                </label>
              );
            })}
          </div>
          {noneConfigured && (
            <p className="mt-1 text-[11px] text-fg-subtle">
              No provider keys configured. Add one (a server env var, or under{" "}
              <strong>Provider keys</strong>) to create keys for it.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs font-medium text-fg-muted">
            Assign to
            <select
              className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">— unassigned (admin only) —</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.username}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-fg-muted">
            Budget (USD)
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="unlimited"
              className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
        </div>

        <label className="block text-xs font-medium text-fg-muted">
          Budget period
          <select
            className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
            value={budgetPeriod}
            onChange={(e) => setBudgetPeriod(e.target.value as BudgetPeriod)}
          >
            <option value="day">1 day</option>
            <option value="week">1 week</option>
            <option value="month">1 month</option>
            <option value="custom">Custom range</option>
          </select>
        </label>

        {budgetPeriod === "custom" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs font-medium text-fg-muted">
              Budget from
              <input
                type="date"
                className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
                value={budgetStart}
                onChange={(e) => setBudgetStart(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-fg-muted">
              to (inclusive)
              <input
                type="date"
                min={budgetStart || undefined}
                className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
                value={budgetEnd}
                onChange={(e) => setBudgetEnd(e.target.value)}
              />
            </label>
          </div>
        )}

        <fieldset className="rounded-md border border-line p-2" data-testid="create-key-logging">
          <legend className="px-1 text-[11px] font-medium text-fg-muted">Logging for this key (off by default)</legend>
          <label className="flex items-start gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={logText}
              onChange={(e) => {
                setLogText(e.target.checked);
                if (!e.target.checked) setLogImages(false);
              }}
            />
            <span>Log prompts &amp; responses for this key (stored encrypted, deleted after the retention period)</span>
          </label>
          <label className={"mt-1 flex items-start gap-2 text-xs " + (logText ? "text-fg-muted" : "text-fg-subtle")}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={logImages}
              disabled={!logText}
              onChange={(e) => setLogImages(e.target.checked)}
            />
            <span>Also store images (needs the option above)</span>
          </label>
          {(logText && masterText === false) || (logImages && masterImages === false) ? (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              {logText && masterText === false
                ? "The workspace's Prompt & response logging is off, so this key won't be logged until an admin turns it on."
                : "The workspace's image logging is off, so images won't be stored until an admin turns it on."}
            </p>
          ) : null}
        </fieldset>

        <p className="text-[11px] text-fg-subtle">
          {willBeLive
            ? "This key makes live calls on the workspace's provider key, under that provider's monthly cap. Pause it any time from the table below."
            : "Add a configured provider above — a key with no provider key returns an error, not a response."}
        </p>

        <button
          onClick={submit}
          disabled={!label.trim() || picked.length === 0}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Create key
        </button>

        {err && <div className="text-sm text-red-600 dark:text-red-400">{err}</div>}

        {created && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
              Copy this key now — it is shown only once.
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-surface px-2 py-1 font-mono text-xs text-fg">
                {created.key}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(created.key);
                  setCopied(true);
                }}
                className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
              {created.label} · {created.allowed_providers.join(", ")}
              {created.allow_live ? " · live-allowed" : ""}
            </div>
          </div>
        )}

        {created && (
          // Only what the readiness checklist needs — the plaintext key never enters the guide.
          <ConnectPanel
            key={created.id} // a new key starts the guide afresh (provider tab, hosted/local choice)
            keyInfo={{ allowed_providers: created.allowed_providers, allow_live: created.allow_live, expires_at: created.expires_at }}
            configuredProviders={configuredProviders}
          />
        )}
      </div>
    </Card>
  );
}
