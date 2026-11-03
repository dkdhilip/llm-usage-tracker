import { useCallback, useEffect, useState } from "react";
import {
  api,
  type GuardrailActivity,
  type GuardrailPreset,
  type GuardrailRule,
  type GuardrailRuleSet,
  type GuardrailRuleSets,
  type GuardrailStatus,
  type KeyRow,
} from "../../../lib/api";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Dialog, DialogContent } from "../../../components/ui/Dialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Field, Input } from "../../../components/ui/Field";
import { InlineAlert } from "../../../components/ui/InlineAlert";
import { useConfirmDialog } from "../../../components/ui/useConfirmDialog";
import { RuleDialog } from "./RuleDialog";
import { ACTION_LABEL, KIND_LABEL, activityLabel, ruleSummary } from "./labels";

/** The Guardrails tab: content rules an admin attaches to virtual keys. A rule set is a named group of rules; each
 *  rule either flags a request (it goes through, and the admin is told) or blocks it (it never reaches the provider). */
export function GuardrailsTab({ keys, onChange }: { keys: KeyRow[]; onChange: () => void }) {
  const [data, setData] = useState<GuardrailRuleSets | null>(null);
  const [presets, setPresets] = useState<GuardrailPreset[]>([]);
  const [status, setStatus] = useState<GuardrailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSet, setNewSet] = useState(false);
  const [editing, setEditing] = useState<{ set: GuardrailRuleSet; rule: GuardrailRule | null } | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<GuardrailActivity[] | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  const load = useCallback(() => {
    setError(null);
    api.guardrails.ruleSets().then(setData).catch((e: Error) => setError(e.message));
    api.guardrails.status().then(setStatus).catch(() => {});
    api.guardrails.presets().then(setPresets).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const changed = () => {
    load();
    onChange(); // key rows show which sets they use
    if (showActivity) api.guardrails.activity().then((a) => setActivity(a.items)).catch(() => {});
  };
  const presetLabel = (id: string) => presets.find((p) => p.id === id)?.label ?? id;
  const keyLabel = (id: number) => keys.find((k) => k.id === id)?.label ?? `key ${id}`;
  const totalRules = (data?.items ?? []).reduce((n, s) => n + s.rules.length, 0);

  async function run(job: () => Promise<unknown>) {
    setError(null);
    try {
      await job();
      changed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The first rule in the workspace is the moment members' prompts start being read for matches: say so once.
  async function consentToFirstRule(): Promise<boolean> {
    if (totalRules > 0) return true;
    return confirm({
      title: "Before you add the first rule",
      confirmLabel: "I understand",
      tone: "default",
      body: (
        <>
          <p>
            Content rules read the text of requests sent with the keys they are attached to. When a rule matches, you can
            see a short, redacted piece of the surrounding text (never the matched text itself) for {status?.retention_days ?? 30} days.
          </p>
          <p className="mt-2">Tell your team that requests may be checked. This is a policy aid, not a security boundary.</p>
        </>
      ),
    });
  }

  async function saveRule(
    set: GuardrailRuleSet,
    rule: GuardrailRule | null,
    body: { name: string; kind: GuardrailRule["kind"]; pattern: string | null; preset_id: string | null; action: GuardrailRule["action"]; whole_word: boolean },
  ) {
    if (!rule && !(await consentToFirstRule())) throw new Error("Cancelled: no rule was added.");
    if (rule) await api.guardrails.updateRule(rule.id, body);
    else await api.guardrails.createRule(set.id, body);
    setEditing(null);
    changed();
  }

  async function removeSet(s: GuardrailRuleSet) {
    const ok = await confirm({
      title: "Delete this rule set?",
      confirmLabel: "Delete rule set",
      tone: "danger",
      body: (
        <p>
          <strong>{s.name}</strong> and its {s.rules.length} rule{s.rules.length === 1 ? "" : "s"} are deleted
          {s.key_ids.length ? `, and it stops applying to ${s.key_ids.length} key${s.key_ids.length === 1 ? "" : "s"}` : ""}. Past matches
          are kept until they expire.
        </p>
      ),
    });
    if (ok) await run(() => api.guardrails.deleteSet(s.id));
  }

  async function removeRule(r: GuardrailRule) {
    const ok = await confirm({
      title: "Delete this rule?",
      confirmLabel: "Delete rule",
      tone: "danger",
      body: <p>The rule “{r.name}” stops applying immediately. Past matches are kept until they expire.</p>,
    });
    if (ok) await run(() => api.guardrails.deleteRule(r.id));
  }

  function toggleActivity() {
    const next = !showActivity;
    setShowActivity(next);
    if (next && activity === null) api.guardrails.activity().then((a) => setActivity(a.items)).catch(() => setActivity([]));
  }

  const limits = data?.limits;
  const recent = status?.last_24h;

  return (
    <div className="space-y-4">
      {dialog}
      {error && (
        <InlineAlert tone="error" title="Something went wrong" action={<Button size="sm" onClick={load}>Retry</Button>}>
          {error}
        </InlineAlert>
      )}

      {data && !data.enabled && (
        <InlineAlert tone="warning" title="Content rules are not being enforced yet">
          You can create and attach rules now, but they only apply once the server's <code className="font-mono text-xs">GUARDRAILS_ENABLED</code>{" "}
          setting is switched on.
        </InlineAlert>
      )}
      {status?.recording.throttled_at && (
        <InlineAlert tone="warning" title="Matches were not all recorded">
          Too many matches arrived in one hour (limit {status.recording.ceiling_per_hour}). Blocking carried on, but some matches have no record.
        </InlineAlert>
      )}
      {(status?.evidence_gaps.length ?? 0) > 0 && (
        <InlineAlert tone="warning" title="Some matches could not be recorded">
          A storage problem stopped {status!.evidence_gaps.reduce((n, g) => n + (g.count ?? 0), 0)} recent matches from being saved. Blocking was not affected.
        </InlineAlert>
      )}

      <section aria-labelledby="guardrails-title" className="rounded-xl border border-line bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 id="guardrails-title" className="text-sm font-semibold text-fg">
              Content rules
            </h2>
            {data && (
              <span className="text-ui text-fg-muted">
                {data.items.length} rule set{data.items.length === 1 ? "" : "s"} · {totalRules} rule{totalRules === 1 ? "" : "s"}
                {recent ? ` · last 24 h: ${recent.blocked} blocked, ${recent.flagged} flagged${recent.unchecked ? `, ${recent.unchecked} not fully checked` : ""}` : ""}
              </span>
            )}
          </div>
          <Button variant="primary" disabled={!data || (limits ? data.items.length >= limits.sets_per_workspace : false)} onClick={() => setNewSet(true)}>
            <span aria-hidden="true">+</span> New rule set
          </Button>
        </div>

        <div className="divide-y divide-line">
          {!data && !error && <p className="p-4 text-sm text-fg-muted">Loading…</p>}
          {data && data.items.length === 0 && (
            <EmptyState
              title="No content rules yet"
              description="Create a rule set (for example “No secrets”), add rules to it, then attach it to the keys it should watch. Start with Flag to see what a rule catches before you Block."
              action={
                <Button variant="primary" onClick={() => setNewSet(true)}>
                  New rule set
                </Button>
              }
            />
          )}
          {data?.items.map((s) => (
            <article key={s.id} aria-label={`Rule set ${s.name}`} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                    {s.name}
                    <Badge variant={s.enabled ? "success" : "neutral"} dot>
                      {s.enabled ? "On" : "Off"}
                    </Badge>
                  </h3>
                  {s.description && <p className="text-sm text-fg-muted">{s.description}</p>}
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {s.key_ids.length === 0 ? "Not attached to any key yet — attach it from a key's menu." : `Used by ${s.key_ids.map(keyLabel).join(", ")}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => run(() => api.guardrails.updateSet(s.id, { enabled: !s.enabled }))}>
                    {s.enabled ? "Turn off" : "Turn on"}
                    <span className="sr-only"> {s.name}</span>
                  </Button>
                  <Button size="sm" disabled={!!limits && s.rules.length >= limits.rules_per_set} onClick={() => setEditing({ set: s, rule: null })}>
                    Add rule<span className="sr-only"> to {s.name}</span>
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => removeSet(s)}>
                    Delete<span className="sr-only"> {s.name}</span>
                  </Button>
                </div>
              </div>

              {s.rules.length === 0 ? (
                <p className="text-sm text-fg-muted">No rules in this set yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-md border border-line" aria-label={`Rules in ${s.name}`}>
                  {s.rules.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={r.enabled ? "font-medium text-fg" : "font-medium text-fg-muted line-through"}>{r.name}</span>
                          <Badge variant={r.action === "block" ? "danger" : "warning"}>{ACTION_LABEL[r.action]}</Badge>
                          <span className="text-xs text-fg-muted">{KIND_LABEL[r.kind]}</span>
                          {!r.enabled && <Badge>Off</Badge>}
                        </div>
                        <div className={"max-w-full break-words text-xs text-fg-muted " + (r.kind === "regex" ? "font-mono" : "")}>{ruleSummary(r, presetLabel)}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => run(() => api.guardrails.updateRule(r.id, { enabled: !r.enabled }))}>
                          {r.enabled ? "Disable" : "Enable"}
                          <span className="sr-only"> {r.name}</span>
                        </Button>
                        {r.kind !== "preset" && (
                          <Button size="sm" onClick={() => setEditing({ set: s, rule: r })}>
                            Edit<span className="sr-only"> {r.name}</span>
                          </Button>
                        )}
                        <Button size="sm" variant="danger" onClick={() => removeRule(r)}>
                          Delete<span className="sr-only"> {r.name}</span>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
        <p className="border-t border-line px-4 py-3 text-xs text-fg-muted">
          Content rules are a policy aid, not a security boundary: words and patterns can be bypassed by misspelling, other languages or encodings. Images and
          audio are not scanned. Matches are kept for {status?.retention_days ?? 30} days.
        </p>
      </section>

      <section aria-labelledby="guardrails-activity" className="rounded-xl border border-line bg-surface shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <h2 id="guardrails-activity" className="text-sm font-semibold text-fg">
            Activity
          </h2>
          <Button size="sm" aria-expanded={showActivity} onClick={toggleActivity}>
            {showActivity ? "Hide" : "Show"} recent changes
          </Button>
        </div>
        {showActivity && (
          <div className="border-t border-line px-4 py-3">
            {activity === null ? (
              <p className="text-sm text-fg-muted">Loading…</p>
            ) : activity.length === 0 ? (
              <p className="text-sm text-fg-muted">No changes yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm" aria-label="Recent guardrail changes">
                {activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-x-3">
                    <time dateTime={a.ts} className="text-xs text-fg-muted">
                      {new Date(a.ts).toLocaleString()}
                    </time>
                    <span className="text-fg">{activityLabel(a.action)}</span>
                    {typeof a.detail.name === "string" && <span className="text-fg-muted">{a.detail.name}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {newSet && (
        <NewSetDialog
          onClose={() => setNewSet(false)}
          onCreate={async (name, description) => {
            await api.guardrails.createSet({ name, description: description || null });
            setNewSet(false);
            changed();
          }}
        />
      )}
      {editing && limits && (
        <RuleDialog
          setName={editing.set.name}
          rule={editing.rule}
          patternLimit={limits.pattern_chars}
          onSave={(body) => saveRule(editing.set, editing.rule, body)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function NewSetDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onCreate(name.trim(), description.trim());
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New rule set" description="A rule set is a named group of rules you can attach to several keys.">
        <div className="space-y-3 p-4">
          <Field label="Name">{(c) => <Input {...c} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. No secrets" />}</Field>
          <Field label="Description (optional)">
            {(c) => <Input {...c} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          {err && <InlineAlert tone="error">{err}</InlineAlert>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim() || busy} onClick={submit}>
              Create rule set
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
