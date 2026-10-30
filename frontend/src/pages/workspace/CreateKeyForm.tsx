import { useCallback, useEffect, useState } from "react";
import { api, PROVIDERS, type BudgetPeriod, type KeyCreated } from "../../lib/api";
import { Card } from "../../components/Card";
import { ConnectPanel } from "../../components/ConnectPanel";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { InlineAlert } from "../../components/ui/InlineAlert";
import { providerName } from "../../lib/format";
import { SecretBox } from "./SecretBox";

// ---------- create key ----------
export function CreateKeyForm({
  onCreated,
  configuredProviders,
  members,
  masterText,
  masterImages,
  framed = true,
}: {
  /** false when the form sits in a drawer that already has its own title and frame */
  framed?: boolean;
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

  const hint = "text-xs text-fg-muted";
  const body = (
    <div className="space-y-4">
      <div>
        <Input
          aria-label="Key label"
          placeholder="Label — e.g. Jane (Data Science) or Support Bot"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className={`mt-1.5 ${hint}`} data-testid="label-hint">
          Each active key needs its own name in this workspace, so you can tell who used what.
        </p>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-ui font-medium text-fg">Allowed providers</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {PROVIDERS.map((p) => {
            const ok = canPick(p);
            return (
              <label
                key={p}
                title={ok ? undefined : `No key configured for ${p}`}
                className={`flex min-h-7 items-center gap-1.5 text-sm text-fg ${ok ? "" : "cursor-not-allowed opacity-50"}`}
              >
                <input type="checkbox" checked={allowed.includes(p)} disabled={!ok} onChange={() => toggle(p)} />
                <span>{providerName(p)}</span>
              </label>
            );
          })}
        </div>
        {noneConfigured && (
          <p className={`mt-1.5 ${hint}`}>
            No provider keys configured. Add one (a server env var, or on the <strong>Providers</strong> tab) to create keys
            for it.
          </p>
        )}
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Assign to">
          {(c) => (
            <Select {...c} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">— unassigned (admin only) —</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.username}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Budget (USD)">
          {(c) => <Input {...c} type="number" step="0.01" min="0" placeholder="unlimited" value={budget} onChange={(e) => setBudget(e.target.value)} />}
        </Field>
      </div>

      <Field label="Budget period">
        {(c) => (
          <Select {...c} value={budgetPeriod} onChange={(e) => setBudgetPeriod(e.target.value as BudgetPeriod)}>
            <option value="day">1 day</option>
            <option value="week">1 week</option>
            <option value="month">1 month</option>
            <option value="custom">Custom range</option>
          </Select>
        )}
      </Field>

      {budgetPeriod === "custom" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Budget from">{(c) => <Input {...c} type="date" value={budgetStart} onChange={(e) => setBudgetStart(e.target.value)} />}</Field>
          <Field label="to (inclusive)">
            {(c) => <Input {...c} type="date" min={budgetStart || undefined} value={budgetEnd} onChange={(e) => setBudgetEnd(e.target.value)} />}
          </Field>
        </div>
      )}

      <fieldset className="rounded-md border border-line p-3" data-testid="create-key-logging">
        <legend className="px-1 text-ui font-medium text-fg">Logging for this key (off by default)</legend>
        <label className="flex min-h-7 items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-1"
            checked={logText}
            onChange={(e) => {
              setLogText(e.target.checked);
              if (!e.target.checked) setLogImages(false);
            }}
          />
          <span>Log prompts &amp; responses for this key (stored encrypted, deleted after the retention period)</span>
        </label>
        <label className={"mt-1 flex min-h-7 items-start gap-2 text-sm " + (logText ? "text-fg" : "text-fg-muted")}>
          <input type="checkbox" className="mt-1" checked={logImages} disabled={!logText} onChange={(e) => setLogImages(e.target.checked)} />
          <span>Also store images (needs the option above)</span>
        </label>
        {(logText && masterText === false) || (logImages && masterImages === false) ? (
          <p className="mt-2 text-xs text-warning-fg">
            {logText && masterText === false
              ? "The workspace's Prompt & response logging is off, so this key won't be logged until an admin turns it on."
              : "The workspace's image logging is off, so images won't be stored until an admin turns it on."}
          </p>
        ) : null}
      </fieldset>

      <p className={hint}>
        {willBeLive
          ? "This key makes live calls on the workspace's provider key, under that provider's monthly cap. Pause it any time from the key's menu."
          : "Add a configured provider above — a key with no provider key returns an error, not a response."}
      </p>

      <Button variant="primary" size="lg" className="w-full sm:w-auto" onClick={submit} disabled={!label.trim() || picked.length === 0}>
        Create key
      </Button>

      {err && <InlineAlert tone="error">{err}</InlineAlert>}

      {created && (
        <SecretBox title={<div>Copy this key now — it is shown only once.</div>} value={created.key} what="Key">
          {created.label} · {created.allowed_providers.join(", ")}
          {created.allow_live ? " · live-allowed" : ""}
        </SecretBox>
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
  );
  return framed ? <Card title="Create a virtual key">{body}</Card> : <div className="p-4">{body}</div>;
}
