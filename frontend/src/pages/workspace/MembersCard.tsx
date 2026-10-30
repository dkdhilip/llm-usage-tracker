import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { Card } from "../../components/Card";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";
import { num } from "../../lib/format";

// ---------- members + invites ----------
export function MembersCard({
  ws,
  onChange,
}: {
  ws: WorkspaceDetail;
  onChange: () => void;
}) {
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<{ code: string; label: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (kind: string, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const { confirm, dialog } = useConfirmDialog();
  const members = ws.members ?? [];
  const invites = ws.invites ?? [];

  return (
    <Card title={`Members (${members.length})`}>
      {dialog}
      <div className="space-y-3">
        <div className="relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" tabIndex={0} role="region" aria-label="Members table">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-subtle">
                <th className="py-1.5 pr-3">User</th>
                <th className="py-1.5 pr-3">Role</th>
                <th className="py-1.5 pr-3 text-right">Keys</th>
                <th className="py-1.5 pr-3 text-right">Requests</th>
                <th className="py-1.5 pr-0">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{m.username}</td>
                  <td className="py-1.5 pr-3 text-xs text-fg-muted">
                    {m.role === "admin" ? "Workspace Admin" : "Team Member"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.assigned_keys}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{num(m.requests)}</td>
                  <td className="py-1.5 pr-0 text-right">
                    {m.role === "member" && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Remove ${m.username}?`,
                            body: `${m.username} loses access to this workspace, and any keys assigned to them become unassigned.`,
                            confirmLabel: "Remove",
                            tone: "danger",
                          });
                          if (ok) void run("rm" + m.user_id, () => api.removeMember(m.user_id));
                        }}
                        disabled={busy !== null}
                        className="rounded border border-line px-2 py-1 min-h-7 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Invite a Team Member
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="flex-1 rounded-md border border-line px-2 py-1.5 text-sm"
              aria-label="Invite label (optional)"
              placeholder="label (optional) — e.g. Jane"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              onClick={() =>
                void run("mint", async () => {
                  const inv = await api.createInvite(label);
                  setMinted({ code: inv.code, label: inv.label });
                  setLabel("");
                })
              }
              disabled={busy !== null}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Generate invite
            </button>
          </div>

          {minted && (
            <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <div className="font-medium text-emerald-800 dark:text-emerald-300">
                Send this code to {minted.label ?? "your Team Member"} — it works once.
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-surface px-2 py-1 font-mono">
                  {minted.code}
                </code>
                <button
                  onClick={() => navigator.clipboard?.writeText(minted.code)}
                  className="rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-700"
                >
                  Copy
                </button>
              </div>
            </div>
          )}

          {invites.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {invites.map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center gap-2 rounded bg-fill px-2 py-1"
                >
                  <code className="font-mono">{inv.code}</code>
                  {inv.label && <span className="text-fg-muted">· {inv.label}</span>}
                  <span className="text-fg-subtle">
                    · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => void run("rev" + inv.id, () => api.revokeInvite(inv.id))}
                    disabled={busy !== null}
                    className="ml-auto text-brand-600 hover:underline disabled:opacity-50 inline-flex min-h-7 items-center"
                  >
                    revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      </div>
    </Card>
  );
}
