import { useState } from "react";
import { api, type WorkspaceDetail } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/ui/Field";
import { InlineAlert } from "../../components/ui/InlineAlert";
import { ScrollRegion } from "../../components/ui/ScrollRegion";
import { useConfirmDialog } from "../../components/ui/useConfirmDialog";
import { num } from "../../lib/format";
import { SecretBox } from "./SecretBox";

const TH = "py-2 pr-3 text-left text-meta font-medium uppercase tracking-wide text-fg-muted";

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
      <div className="space-y-5">
        <ScrollRegion label="Members table">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={TH}>User</th>
                <th scope="col" className={TH}>Role</th>
                <th scope="col" className={`${TH} text-right`}>Keys</th>
                <th scope="col" className={`${TH} text-right`}>Requests</th>
                <th scope="col" className={`${TH} pr-0`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-b border-line last:border-0">
                  <td className="py-2.5 pr-3 font-medium text-fg">{m.username}</td>
                  <td className="py-2.5 pr-3">
                    <Badge variant={m.role === "admin" ? "brand" : "neutral"}>
                      {m.role === "admin" ? "Workspace Admin" : "Team Member"}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{m.assigned_keys}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{num(m.requests)}</td>
                  <td className="py-2.5 pr-0 text-right">
                    {m.role === "member" && (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Remove ${m.username}`}
                        disabled={busy !== null}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Remove ${m.username}?`,
                            body: `${m.username} loses access to this workspace, and any keys assigned to them become unassigned.`,
                            confirmLabel: "Remove",
                            tone: "danger",
                          });
                          if (ok) void run("rm" + m.user_id, () => api.removeMember(m.user_id));
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>

        <div className="border-t border-line pt-4">
          <h3 className="mb-2 text-meta font-semibold uppercase tracking-wider text-fg-muted">Invite a Team Member</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              aria-label="Invite label (optional)"
              placeholder="label (optional) — e.g. Jane"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() =>
                void run("mint", async () => {
                  const inv = await api.createInvite(label);
                  setMinted({ code: inv.code, label: inv.label });
                  setLabel("");
                })
              }
            >
              Generate invite
            </Button>
          </div>

          {minted && (
            <div className="mt-3">
              <SecretBox title={`Send this code to ${minted.label ?? "your Team Member"} — it works once.`} value={minted.code} what="Invite code" />
            </div>
          )}

          {invites.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-ui">
              {invites.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-fill px-3 py-1.5">
                  <code className="font-mono">{inv.code}</code>
                  {inv.label && <span className="text-fg-muted">· {inv.label}</span>}
                  <span className="text-fg-muted">· expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={`Revoke invite ${inv.code}`}
                    disabled={busy !== null}
                    onClick={() => void run("rev" + inv.id, () => api.revokeInvite(inv.id))}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <InlineAlert tone="error">{err}</InlineAlert>}
      </div>
    </Card>
  );
}
