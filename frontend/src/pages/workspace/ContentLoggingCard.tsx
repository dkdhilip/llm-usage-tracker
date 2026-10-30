import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { Card } from "../../components/Card";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";

// ---------- content logging ----------
export function ContentLoggingCard({ ws, onChange }: { ws: WorkspaceDetail; onChange: () => void }) {
  const state = ws.content_logging;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!state) return null;

  const { confirm, dialog } = useConfirmDialog();
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
      <div className="space-y-3 text-sm">
        <p className="text-xs text-fg-muted">
          Off by default. When on, new requests are stored encrypted with their prompt and response
          (media, embedding vectors and credentials are never stored) and visible only to workspace
          admins. Each record is deleted automatically after {state.retention_days} days. Usage
          analytics are not affected.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs font-medium " +
              (state.enabled
                ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                : "bg-fill text-fg-muted")
            }
          >
            {state.enabled ? "On" : "Off"}
          </span>
          {state.updated_at && (
            <span className="text-xs text-fg-subtle">
              changed {new Date(state.updated_at).toLocaleString()}
            </span>
          )}
          <button
            onClick={toggle}
            disabled={busy !== null}
            className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm text-fg-muted hover:bg-fill disabled:opacity-50"
          >
            {state.enabled ? "Turn off" : "Turn on"}
          </button>
          <button
            onClick={purge}
            disabled={busy !== null}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            Delete stored content
          </button>
        </div>
        {state.keys_total !== undefined && (
          <p className="text-xs text-fg-muted" data-testid="keys-logging-summary">
            This is the workspace master switch. A key is only logged when this is on <em>and</em> the key's own
            switch is on (set when creating a key or in the Virtual keys table).{" "}
            <strong>
              {state.keys_logging ?? 0} of {state.keys_total} key{state.keys_total === 1 ? "" : "s"}
            </strong>{" "}
            currently {state.enabled ? "log" : "have logging switched on (inactive while this is off)"}.
          </p>
        )}
        <ImageLoggingSection ws={ws} textOn={state.enabled} onChange={onChange} />
        {state.enabled === false && (
          <p className="text-xs text-fg-subtle">
            Turning it off stops new capture; records already stored stay until they expire or you
            delete them.
          </p>
        )}
        {note && <div className="text-xs text-fg-muted">{note}</div>}
        {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
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
  if (!img) return null;
  const used = img.used_bytes ?? 0;
  const cap = img.cap_bytes ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  const { confirm, dialog } = useConfirmDialog();
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
    <div className="space-y-2 border-t border-line pt-3" data-testid="image-logging">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-fg">Store images</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-xs font-medium " +
            (img.enabled
              ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
              : "bg-fill text-fg-muted")
          }
        >
          {img.enabled ? "Images on" : "Images off"}
        </span>
        <button
          onClick={toggle}
          disabled={busy}
          className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm text-fg-muted hover:bg-fill disabled:opacity-50"
        >
          {img.enabled ? "Turn off images" : "Turn on images"}
        </button>
      </div>
      <p className="text-xs text-fg-muted">
        Separate from text logging and off by default. Needs text logging on to take effect
        {img.enabled && !textOn ? " (text logging is currently off, so no images are being stored)" : ""}.
        Images live in the app database, so space is limited
        {img.max_image_bytes ? ` (up to ${mb(img.max_image_bytes)} per image` : ""}
        {img.max_per_request ? `, ${img.max_per_request} per request)` : img.max_image_bytes ? ")" : ""}.
        Links to images are never downloaded or stored. Each key also needs its own image switch
        {img.enabled ? "" : " (inactive while this is off)"}.
      </p>
      {cap > 0 && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-fg-muted">
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
            <div className={"h-full " + (pct >= 90 ? "bg-red-500" : "bg-brand-600")} style={{ width: `${pct}%` }} />
          </div>
          {(used >= cap || img.global_full) && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {used >= cap
                ? "The image limit for this workspace is reached: new images are skipped until old ones expire or are deleted."
                : "The shared image storage is full: new images are skipped for now."}
            </p>
          )}
        </div>
      )}
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
    </div>
  );
}
