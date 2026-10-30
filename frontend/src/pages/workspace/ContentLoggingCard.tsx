import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { InlineAlert } from "../../components/ui/InlineAlert";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";

// ---------- content logging ----------
export function ContentLoggingCard({ ws, onChange }: { ws: WorkspaceDetail; onChange: () => void }) {
  const state = ws.content_logging;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // hooks come before the early return below: the card appears once the workspace has loaded
  const { confirm, dialog } = useConfirmDialog();
  if (!state) return null;

  const toggle = async () => {
    const next = !state.enabled;
    if (
      next &&
      !(await confirm({
        title: "Store prompts and responses?",
        body:
          `Store the full prompts and responses of this workspace's requests for ${state.retention_days} days? ` +
          "Workspace admins will be able to read them, and they may contain personal or sensitive data. " +
          "Everyone in the workspace can see that this is on.",
        confirmLabel: "Turn on",
      }))
    )
      return;
    setBusy("toggle");
    setErr(null);
    setNote(null);
    try {
      await api.setContentLogging(next);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const purge = async () => {
    if (
      !(await confirm({
        title: "Delete stored content?",
        body: "Delete all stored prompts and responses of this workspace now? Usage analytics are kept.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    )
      return;
    setBusy("purge");
    setErr(null);
    setNote(null);
    try {
      const r = await api.deleteStoredContent();
      setNote(`Deleted ${r.deleted} stored record${r.deleted === 1 ? "" : "s"}.`);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Prompt & response logging">
      {dialog}
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Off by default. When on, new requests are stored encrypted with their prompt and response (media, embedding
          vectors and credentials are never stored) and visible only to workspace admins. Each record is deleted
          automatically after {state.retention_days} days. Usage analytics are not affected.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={state.enabled ? "success" : "neutral"} dot>
            {state.enabled ? "On" : "Off"}
          </Badge>
          {state.updated_at && <span className="text-ui text-fg-muted">changed {new Date(state.updated_at).toLocaleString()}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button onClick={toggle} disabled={busy !== null}>
              {state.enabled ? "Turn off" : "Turn on"}
            </Button>
            <Button variant="danger" onClick={purge} disabled={busy !== null}>
              Delete stored content
            </Button>
          </div>
        </div>
        {state.keys_total !== undefined && (
          <p className="text-sm text-fg-muted" data-testid="keys-logging-summary">
            This is the workspace master switch. A key is only logged when this is on <em>and</em> the key's own switch
            is on (set when creating a key or from the key's menu on the Keys tab).{" "}
            <strong className="text-fg">
              {state.keys_logging ?? 0} of {state.keys_total} key{state.keys_total === 1 ? "" : "s"}
            </strong>{" "}
            currently {state.enabled ? "log" : "have logging switched on (inactive while this is off)"}.
          </p>
        )}
        <ImageLoggingSection ws={ws} textOn={state.enabled} onChange={onChange} />
        {state.enabled === false && (
          <p className="text-sm text-fg-muted">
            Turning it off stops new capture; records already stored stay until they expire or you delete them.
          </p>
        )}
        {note && (
          <InlineAlert tone="success" role="status">
            {note}
          </InlineAlert>
        )}
        {err && <InlineAlert tone="error">{err}</InlineAlert>}
      </div>
    </Card>
  );
}

export const mb = (n: number) =>
  n > 0 && n < 1_000_000 ? `${Math.ceil(n / 1000)} KB` : `${Number((n / 1_000_000).toFixed(1))} MB`;

export function ImageLoggingSection({
  ws,
  textOn,
  onChange,
}: {
  ws: WorkspaceDetail;
  textOn: boolean;
  onChange: () => void;
}) {
  const img = ws.image_logging;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  if (!img) return null;
  const used = img.used_bytes ?? 0;
  const cap = img.cap_bytes ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  const toggle = async () => {
    const next = !img.enabled;
    if (
      next &&
      !(await confirm({
        title: "Also store images?",
        body:
          "Also store the actual images (pictures sent to vision models and images the model generates)? " +
          "Images can contain faces and personal data and cannot be redacted. Workspace admins will be able " +
          "to view them for the retention period. Only PNG, JPEG, GIF and WebP embedded in the request are " +
          "kept (never downloaded from a link), they are encrypted, and storage is capped.",
        confirmLabel: "Turn on",
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await api.setImageLogging(next);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-line pt-4" data-testid="image-logging">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">Store images</span>
        <Badge variant={img.enabled ? "success" : "neutral"} dot>
          {img.enabled ? "Images on" : "Images off"}
        </Badge>
        <Button className="ml-auto" onClick={toggle} disabled={busy}>
          {img.enabled ? "Turn off images" : "Turn on images"}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        Separate from text logging and off by default. Needs text logging on to take effect
        {img.enabled && !textOn ? " (text logging is currently off, so no images are being stored)" : ""}. Images live in
        the app database, so space is limited
        {img.max_image_bytes ? ` (up to ${mb(img.max_image_bytes)} per image` : ""}
        {img.max_per_request ? `, ${img.max_per_request} per request)` : img.max_image_bytes ? ")" : ""}. Links to images
        are never downloaded or stored. Each key also needs its own image switch
        {img.enabled ? "" : " (inactive while this is off)"}.
      </p>
      {cap > 0 && (
        <div>
          <div className="mb-1.5 flex justify-between text-ui text-fg-muted">
            <span>Image storage used</span>
            <span>
              {mb(used)} of {mb(cap)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Image storage used"
            aria-valuetext={`${mb(used)} of ${mb(cap)}`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded bg-fill"
          >
            <div className={"h-full " + (pct >= 90 ? "bg-red-600" : "bg-brand-600")} style={{ width: `${pct}%` }} />
          </div>
          {(used >= cap || img.global_full) && (
            <p className="mt-2 text-sm text-warning-fg">
              {used >= cap
                ? "The image limit for this workspace is reached: new images are skipped until old ones expire or are deleted."
                : "The shared image storage is full: new images are skipped for now."}
            </p>
          )}
        </div>
      )}
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
    </div>
  );
}
