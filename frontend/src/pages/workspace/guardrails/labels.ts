import type { GuardrailAction, GuardrailKind, GuardrailRule } from "../../../lib/api";

export const KIND_LABEL: Record<GuardrailKind, string> = {
  phrase: "Words or phrase",
  regex: "Pattern (regex)",
  preset: "Built-in detector",
};

export const ACTION_LABEL: Record<GuardrailAction, string> = { flag: "Flag", block: "Block" };

export const ACTION_HELP: Record<GuardrailAction, string> = {
  flag: "The request goes through, and you are notified.",
  block: "The request is stopped before it reaches the provider (HTTP 403), and you are notified.",
};

/** What a rule looks for, in one line. */
export function ruleSummary(r: GuardrailRule, presetLabel: (id: string) => string): string {
  if (r.kind === "preset") return presetLabel(r.preset_id ?? "");
  return `${r.pattern ?? ""}${r.kind === "phrase" && r.whole_word ? " (whole word)" : ""}`;
}

/** A readable name for an audit event. */
export function activityLabel(action: string): string {
  const map: Record<string, string> = {
    "ruleset.create": "Created a rule set",
    "ruleset.update": "Edited a rule set",
    "ruleset.enable": "Enabled a rule set",
    "ruleset.disable": "Disabled a rule set",
    "ruleset.delete": "Deleted a rule set",
    "rule.create": "Added a rule",
    "rule.update": "Edited a rule",
    "rule.delete": "Deleted a rule",
    "key.guardrails.attach": "Changed a key's content rules",
    "key.guardrails.detach": "Removed a key's content rules",
    "hits.review": "Marked matches as reviewed",
    "guardrail.evidence_gap": "Some matches could not be recorded",
  };
  return map[action] ?? action;
}
