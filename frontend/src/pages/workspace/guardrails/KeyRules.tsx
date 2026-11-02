import { useState } from "react";
import { api, type GuardrailRuleSet, type KeyRow } from "../../../lib/api";
import { Badge } from "../../../components/ui/Badge";
import { InlineAlert } from "../../../components/ui/InlineAlert";

/** The "Content rules" cell of a key: how many rule sets are attached (and whether enforcement is on at all). */
export function KeyRulesPill({ k, ruleSets, enforced }: { k: KeyRow; ruleSets: GuardrailRuleSet[]; enforced?: boolean }) {
  const attached = (k.guardrail_rule_set_ids ?? []).filter((id) => ruleSets.some((s) => s.id === id));
  if (attached.length === 0) return <span className="text-fg-muted">None</span>;
  const label = attached.length === 1 ? (ruleSets.find((s) => s.id === attached[0])?.name ?? "1 set") : `${attached.length} sets`;
  return (
    <Badge
      variant={enforced === false ? "neutral" : "brand"}
      title={enforced === false ? "Rules are attached but content rules are not being enforced yet." : attached.length > 1 ? `${attached.length} rule sets` : undefined}
    >
      {label}
      {enforced === false ? " (inactive)" : ""}
    </Badge>
  );
}

/** Choose which rule sets apply to one key. Saves as you tick: the next request on the key uses the change. */
export function KeyRulesEditor({
  k,
  ruleSets,
  enforced,
  maxSets,
  onChange,
}: {
  k: KeyRow;
  ruleSets: GuardrailRuleSet[];
  enforced?: boolean;
  maxSets: number;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const attached = k.guardrail_rule_set_ids ?? [];
  const who = `${k.label} (${k.key_prefix}…)`;

  async function toggle(id: number, on: boolean) {
    const next = on ? [...attached, id] : attached.filter((x) => x !== id);
    setBusy(true);
    setErr(null);
    try {
      await api.guardrails.setKeyRuleSets(k.id, next);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm" data-testid={`key-rules-editor-${k.id}`}>
      <div className="text-ui font-medium text-fg">Content rules for {who}</div>
      {ruleSets.length === 0 ? (
        <p className="text-fg-muted">
          No rule sets yet. Create one on the <strong>Guardrails</strong> tab, then attach it here.
        </p>
      ) : (
        <fieldset disabled={busy} className="space-y-0.5">
          <legend className="sr-only">Rule sets applied to {who}</legend>
          {ruleSets.map((s) => {
            const on = attached.includes(s.id);
            return (
              <label key={s.id} className="flex min-h-7 items-start gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={on}
                  disabled={!on && attached.length >= maxSets}
                  onChange={(e) => toggle(s.id, e.target.checked)}
                />
                <span>
                  {s.name}{" "}
                  <span className="text-xs text-fg-muted">
                    · {s.rules.length} rule{s.rules.length === 1 ? "" : "s"}
                    {s.enabled ? "" : " · disabled"}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {enforced === false && attached.length > 0 && (
        <p className="text-xs text-warning-fg">Content rules are not being enforced yet, so these rules do nothing for now.</p>
      )}
      <p className="text-xs text-fg-muted">A key can use up to {maxSets} rule sets. Changes apply to the key's very next request.</p>
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
    </div>
  );
}
