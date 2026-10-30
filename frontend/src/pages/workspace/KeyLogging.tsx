import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { InlineAlert } from "../../components/ui/InlineAlert";
import { api, type KeyRow } from "../../lib/api";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";

// ---------- per-key logging ----------
export function KeyLoggingPill({
  k,
  masterText,
  masterImages,
}: {
  k: KeyRow;
  masterText?: boolean;
  masterImages?: boolean;
}) {
  const text = !!k.content_logging_enabled;
  const images = text && !!k.image_logging_enabled;
  if (!text) return <span className="text-fg-muted">Off</span>;
  const inactive = masterText === false || (images && masterImages === false);
  return (
    <Badge
      variant={inactive ? "neutral" : "brand"}
      title={
        inactive
          ? "This key's switch is on, but a workspace master switch is off, so nothing is being logged yet."
          : undefined
      }
    >
      {images ? "Text + images" : "Text"}
      {inactive ? " (inactive)" : ""}
    </Badge>
  );
}

export function KeyLoggingEditor({
  k,
  masterText,
  masterImages,
  retentionDays,
  onChange,
}: {
  k: KeyRow;
  masterText?: boolean;
  masterImages?: boolean;
  retentionDays: number;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const text = !!k.content_logging_enabled;
  const images = !!k.image_logging_enabled;
  const who = `${k.label} (${k.key_prefix}…)`;

  const { confirm, dialog } = useConfirmDialog();

  async function apply(patch: { content_logging_enabled?: boolean; image_logging_enabled?: boolean }, ask?: string) {
    if (ask && !(await confirm({ title: "Change what is logged?", body: ask, confirmLabel: "Turn on" }))) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateKey(k.id, patch);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm" data-testid={`key-logging-editor-${k.id}`}>
      {dialog}
      <div className="text-ui font-medium text-fg">Logging for {who}</div>
      <label className="flex min-h-7 items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={text}
          disabled={busy}
          onChange={(e) =>
            apply(
              // turning text off also turns images off: images are part of text capture
              e.target.checked ? { content_logging_enabled: true } : { content_logging_enabled: false, image_logging_enabled: false },
              e.target.checked
                ? `Store the full prompts and responses of requests made with ${who} for ${retentionDays} days? ` +
                    "Workspace admins will be able to read them, and they may contain personal or sensitive data."
                : undefined,
            )
          }
        />
        <span>Log prompts &amp; responses for this key</span>
      </label>
      <label className={"flex min-h-7 items-start gap-2 text-sm " + (text ? "text-fg" : "text-fg-muted")}>
        <input
          type="checkbox"
          className="mt-1"
          checked={images}
          disabled={busy || !text}
          onChange={(e) =>
            apply(
              { image_logging_enabled: e.target.checked },
              e.target.checked
                ? `Also store the images sent with, and generated for, requests made with ${who}? ` +
                    "Images can contain faces and personal data and cannot be redacted."
                : undefined,
            )
          }
        />
        <span>Also store images (needs the option above)</span>
      </label>
      {text && masterText === false && (
        <p className="text-xs text-warning-fg">The workspace's Prompt &amp; response logging is off, so nothing is logged for this key yet.</p>
      )}
      {text && images && masterText !== false && masterImages === false && (
        <p className="text-xs text-warning-fg">The workspace's image logging is off, so images are not being stored yet.</p>
      )}
      <p className="text-xs text-fg-muted">
        Turning an option off stops new capture only; content already stored stays until it expires or an admin deletes the
        workspace's stored content.
      </p>
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
    </div>
  );
}
