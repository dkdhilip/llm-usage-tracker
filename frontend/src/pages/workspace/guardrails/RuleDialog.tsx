import { useState } from "react";
import { api, type GuardrailAction, type GuardrailKind, type GuardrailRule, type GuardrailTestResult } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Dialog, DialogContent } from "../../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../../components/ui/Field";
import { InlineAlert } from "../../../components/ui/InlineAlert";
import { ACTION_HELP, ACTION_LABEL } from "./labels";

/** Create or edit one word/phrase rule, with a "Try it" box that runs the same engine the gateway uses on text typed
 *  here (nothing is stored). New rules are always words or phrases (built-in detectors are ticked in their own section
 *  of the rule set); a rule saved earlier as a pattern can still be edited. The server refuses a bad entry with the
 *  reason, which is shown here. */
export function RuleDialog({
  setName,
  rule,
  patternLimit,
  onSave,
  onClose,
}: {
  setName: string;
  rule: GuardrailRule | null; // null = a new rule
  patternLimit: number;
  onSave: (body: { name: string; kind: GuardrailKind; pattern: string | null; preset_id: string | null; action: GuardrailAction; whole_word: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const kind: GuardrailKind = rule?.kind ?? "phrase";
  const [name, setName_] = useState(rule?.name ?? "");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [action, setAction] = useState<GuardrailAction>(rule?.action ?? "flag");
  const [wholeWord, setWholeWord] = useState(rule?.whole_word ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState("");
  const [tried, setTried] = useState<GuardrailTestResult | null>(null);
  const [tryErr, setTryErr] = useState<string | null>(null);

  const ready = name.trim() !== "" && pattern.trim() !== "";
  const spec = { kind, pattern, preset_id: null, whole_word: kind === "phrase" && wholeWord };

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await onSave({ name: name.trim(), action, ...spec });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function tryIt() {
    setTryErr(null);
    setTried(null);
    try {
      setTried(await api.guardrails.test({ ...spec, text: sample }));
    } catch (e) {
      setTryErr((e as Error).message);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent placement="right" title={rule ? "Edit rule" : "Add a rule"} description={`In the rule set “${setName}”.`}>
        <div className="space-y-4 p-4">
          <Field label="Rule name" hint="Shown in notifications and on the Requests page.">
            {(c) => <Input {...c} value={name} maxLength={80} onChange={(e) => setName_(e.target.value)} placeholder="e.g. Internal project name" />}
          </Field>

          <Field
            label={kind === "phrase" ? "Word or phrase" : "Pattern"}
            hint={
              kind === "phrase"
                ? "Not case-sensitive. Also matches simple disguises such as full-width letters or hidden zero-width characters."
                : `Up to ${patternLimit} characters. This rule was saved as a pattern (regular expression); new rules use words or phrases.`
            }
          >
            {(c) => <Input {...c} value={pattern} maxLength={patternLimit} onChange={(e) => setPattern(e.target.value)} className={kind === "regex" ? "font-mono" : undefined} />}
          </Field>

          {kind === "phrase" && (
            <label className="flex min-h-7 items-start gap-2 text-sm text-fg">
              <input type="checkbox" className="mt-1" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
              <span>Whole word only (so “cat” does not match “category”)</span>
            </label>
          )}

          <fieldset>
            <legend className="mb-1.5 text-ui font-medium text-fg">When it matches</legend>
            <div className="space-y-1">
              {(["flag", "block"] as GuardrailAction[]).map((a) => (
                <label key={a} className="flex min-h-7 items-start gap-2 text-sm text-fg">
                  <input type="radio" name="rule-action" className="mt-1" checked={action === a} onChange={() => setAction(a)} />
                  <span>
                    <strong className="font-medium">{ACTION_LABEL[a]}</strong> — {ACTION_HELP[a]}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">New rules are safest as Flag first: check what they catch, then switch to Block.</p>
          </fieldset>

          <div className="rounded-md border border-line bg-surface-2 p-3">
            <Field label="Try it" hint="Runs this rule on the text below. Nothing is saved.">
              {(c) => <Textarea {...c} value={sample} maxLength={20000} onChange={(e) => setSample(e.target.value)} placeholder="Paste some text a user might send" />}
            </Field>
            <Button size="sm" className="mt-2" disabled={!ready || !sample} onClick={tryIt}>
              Try it
            </Button>
            {tried && (
              <p className="mt-2 text-sm text-fg" role="status">
                {tried.matched ? (
                  <>
                    <strong>Matches</strong> ({tried.occurrences} time{tried.occurrences === 1 ? "" : "s"}).
                    {tried.snippet ? <span className="text-fg-muted"> Context: “{tried.snippet}”</span> : null}
                  </>
                ) : (
                  <strong>No match.</strong>
                )}
              </p>
            )}
            {tryErr && (
              <InlineAlert tone="error" className="mt-2">
                {tryErr}
              </InlineAlert>
            )}
          </div>

          {err && <InlineAlert tone="error">{err}</InlineAlert>}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!ready || busy} onClick={save}>
              {rule ? "Save rule" : "Add rule"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
