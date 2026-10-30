import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { Field, Input } from "../../components/ui/Field";
import { InlineAlert } from "../../components/ui/InlineAlert";
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
      <div className="space-y-5">
        <div className="flex items-end gap-2">
          <Field label="Name" className="flex-1">
            {(c) => <Input {...c} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button
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
          >
            Rename
          </Button>
        </div>
        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-danger-fg">Delete workspace</h3>
          <p className="mb-3 mt-1 text-sm text-fg-muted">
            Deleting the workspace removes all its virtual keys, usage, and provider keys. Remove every other member first.
          </p>
          <Button
            variant="danger"
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
          >
            {busy === "delete" ? "Deleting…" : "Delete workspace"}
          </Button>
        </div>
        {err && <InlineAlert tone="error">{err}</InlineAlert>}
      </div>
    </Card>
  );
}
