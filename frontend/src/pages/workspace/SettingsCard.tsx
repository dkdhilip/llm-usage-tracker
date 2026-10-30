import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Card } from "../../components/Card";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";

// ---------- settings ----------
export function SettingsCard({ ws, onChange }: { ws: WorkspaceDetail; onChange: () => void }) {
  const { refresh: refreshAuth } = useAuth();
  const [name, setName] = useState(ws.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { confirm, dialog } = useConfirmDialog();
  return (
    <Card title="Workspace settings">
      {dialog}
      <div className="space-y-3 text-sm">
        <div className="flex items-end gap-2">
          <label className="flex-1 text-xs font-medium text-fg-muted">
            Name
            <input
              className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            onClick={async () => {
              setBusy("rename");
              setErr(null);
              try {
                await api.renameWorkspace(name.trim());
                await refreshAuth();
                onChange();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy !== null || !name.trim() || name.trim() === ws.name}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-fg-muted hover:bg-fill disabled:opacity-50"
          >
            Rename
          </button>
        </div>
        <div className="border-t border-line pt-3">
          <p className="mb-2 text-xs text-fg-muted">
            Deleting the workspace removes all its virtual keys, usage, and provider keys.
            Remove every other member first.
          </p>
          <button
            onClick={async () => {
              const ok = await confirm({
                title: `Delete ${ws.name}?`,
                body: `Delete ${ws.name} and all its data? This removes all its virtual keys, usage and provider keys, and cannot be undone.`,
                confirmLabel: "Delete workspace",
                tone: "danger",
              });
              if (!ok) return;
              setBusy("delete");
              setErr(null);
              try {
                await api.deleteWorkspace();
                await refreshAuth();
              } catch (e) {
                setErr((e as Error).message);
                setBusy(null);
              }
            }}
            disabled={busy !== null}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            {busy === "delete" ? "Deleting…" : "Delete workspace"}
          </button>
        </div>
        {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      </div>
    </Card>
  );
}
