import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/Card";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { useConfirmDialog } from "../components/ui/useConfirmDialog";

export function Account() {
  const { authenticated, loading, user, workspace, role, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  if (loading) {
    return <div className="mx-auto max-w-md p-6 text-sm text-fg-muted">Loading…</div>;
  }
  if (!authenticated) return <Navigate to="/login" replace />;

  async function run(kind: string, fn: () => Promise<unknown>, after: () => void) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      after();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      {dialog}
      <PageHeader
        title="Your account"
        actions={
          <Button onClick={() => void logout()}>Sign out</Button>
        }
      />
      <div className="space-y-4">
        <Card title="Identity">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fg-muted">Username</dt>
              <dd className="font-medium text-fg">{user?.username}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fg-muted">Workspace</dt>
              <dd className="font-medium text-fg">{workspace ? workspace.name : "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fg-muted">Role</dt>
              <dd>
                {role === "admin" ? (
                  <Badge variant="brand">Workspace Admin</Badge>
                ) : role === "member" ? (
                  <Badge>Team Member</Badge>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        </Card>

        {workspace && role === "member" && (
          <Card title="Leave workspace">
            <p className="mb-3 text-sm text-fg-muted">
              You'll lose access to this workspace's data. Any keys assigned to you are unassigned (the admin keeps them).
            </p>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                const ok = await confirm({
                  title: `Leave ${workspace.name}?`,
                  body: "You lose access to this workspace's data. Any keys assigned to you are unassigned (the admin keeps them).",
                  confirmLabel: "Leave workspace",
                  tone: "danger",
                });
                if (!ok) return;
                void run(
                  "leave",
                  () => api.leaveWorkspace(),
                  async () => {
                    await refresh();
                    navigate("/welcome", { replace: true });
                  },
                );
              }}
            >
              {busy === "leave" ? "Leaving…" : "Leave workspace"}
            </Button>
          </Card>
        )}

        <Card title="Danger zone">
          <p className="mb-3 text-sm text-fg-muted">
            Deleting your account is permanent. A Workspace Admin must remove all members and delete the workspace first.
          </p>
          <Button
            variant="danger"
            disabled={busy !== null}
            onClick={async () => {
              const ok = await confirm({
                title: "Permanently delete your account?",
                body: "This cannot be undone. A Workspace Admin must remove all members and delete the workspace first.",
                confirmLabel: "Delete account",
                tone: "danger",
              });
              if (!ok) return;
              void run(
                "delete",
                () => api.deleteAccount(),
                () => void logout(),
              );
            }}
          >
            {busy === "delete" ? "Deleting…" : "Delete account"}
          </Button>
        </Card>

        {msg && <InlineAlert tone="error">{msg}</InlineAlert>}
      </div>
    </div>
  );
}
