import { useId, useState } from "react";
import type { GuardrailAction, GuardrailPreset, GuardrailRule, GuardrailRuleSet } from "../../../lib/api";
import { Badge } from "../../../components/ui/Badge";
import { ChevronDownIcon } from "../../../components/ui/icons";
import { cn } from "../../../lib/cn";
import { ACTION_LABEL } from "./labels";

/** The built-in detectors of one rule set, as a closable section of checkboxes. Ticking a detector adds it to the set
 *  (as Flag, the safe default); unticking removes it; each ticked detector has its own Flag/Block choice. A detector
 *  never stores the text it found: it only records that it matched. */
export function Detectors({
  set,
  presets,
  disabled,
  onAdd,
  onRemove,
  onAction,
}: {
  set: GuardrailRuleSet;
  presets: GuardrailPreset[];
  disabled?: boolean;
  onAdd: (preset: GuardrailPreset) => void;
  onRemove: (rule: GuardrailRule) => void;
  onAction: (rule: GuardrailRule, action: GuardrailAction) => void;
}) {
  const panel = useId();
  const byPreset = new Map(set.rules.filter((r) => r.kind === "preset").map((r) => [r.preset_id, r]));
  const [open, setOpen] = useState(byPreset.size > 0);
  if (presets.length === 0) return null;

  return (
    <div className="rounded-md border border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text"
      >
        <span className="flex flex-wrap items-center gap-2">
          Built-in detectors
          <span className="text-xs font-normal text-fg-muted">
            {byPreset.size === 0 ? "none on" : `${byPreset.size} of ${presets.length} on`}
          </span>
        </span>
        <ChevronDownIcon className={cn("shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul id={panel} className="divide-y divide-line border-t border-line" aria-label={`Built-in detectors in ${set.name}`}>
          {presets.map((p) => {
            const rule = byPreset.get(p.id);
            return (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <label className="flex min-w-0 flex-1 items-start gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!!rule}
                    disabled={disabled}
                    onChange={() => (rule ? onRemove(rule) : onAdd(p))}
                  />
                  <span className="min-w-0">
                    {p.label}
                    <span className="block text-xs text-fg-muted">{p.description}</span>
                  </span>
                </label>
                {rule && (
                  <div className="flex items-center gap-2">
                    <Badge variant={rule.action === "block" ? "danger" : "warning"}>{ACTION_LABEL[rule.action]}</Badge>
                    <select
                      aria-label={`Action for ${p.label}`}
                      value={rule.action}
                      disabled={disabled}
                      onChange={(e) => onAction(rule, e.target.value as GuardrailAction)}
                      className="h-8 rounded-md border border-control bg-surface px-2 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text"
                    >
                      <option value="flag">Flag</option>
                      <option value="block">Block</option>
                    </select>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
