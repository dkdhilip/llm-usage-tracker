import { useState } from "react";
import { api, type KeyRow, type WorkspaceDetail } from "../../lib/api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogContent, DialogTrigger } from "../../components/ui/Dialog";
import { KeyStatusFilter } from "../../components/KeyStatusFilter";
import { DEFAULT_KEY_STATUSES, keyStatus, type KeyStatus } from "../../lib/keyOptions";
import { Checklist } from "./Checklist";
import { CreateKeyForm } from "./CreateKeyForm";
import { KeysTable, type KeyActions } from "./KeysTable";

const REMEMBER = "showRevokedKeys";

/** Revoked keys are tucked away by default (nothing is deleted: their usage history stays in the dashboard). The
 *  choice to show them is remembered in this browser. */
function initialStatuses(): KeyStatus[] {
  try {
    return localStorage.getItem(REMEMBER) === "1" ? ["active", "revoked"] : DEFAULT_KEY_STATUSES;
  } catch {
    return DEFAULT_KEY_STATUSES; // storage blocked
  }
}

function LoggingStrip({ ws, keys, onSettings }: { ws: WorkspaceDetail; keys: KeyRow[]; onSettings: () => void }) {
  const state = ws.content_logging;
  if (!state) return null;
  const active = keys.filter((k) => keyStatus(k) === "active");
  const logged = active.filter((k) => k.content_logging_enabled).length;
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2 text-sm text-fg-muted shadow-sm">
      <span className="flex flex-wrap items-center gap-2">
        <strong className="font-semibold text-fg">Prompt logging</strong>
        <Badge variant={state.enabled ? "success" : "neutral"} dot>
          {state.enabled ? "On" : "Off"}
        </Badge>
        {state.enabled ? (
          <span>
            {logged} of {active.length} keys · Images {ws.image_logging?.enabled ? "on" : "off"}
          </span>
        ) : (
          <span>Stored content is deleted after {state.retention_days ?? 30} days when on.</span>
        )}
      </span>
      <button type="button" onClick={onSettings} className="ml-auto inline-flex min-h-7 items-center text-brand-text underline-offset-2 hover:underline">
        Logging settings
      </button>
    </div>
  );
}

export function KeysTab({
  ws,
  keys,
  configured,
  members,
  refresh,
  onError,
  onTab,
}: {
  ws: WorkspaceDetail | null;
  keys: KeyRow[];
  configured: string[];
  members: { user_id: number; username: string }[];
  refresh: () => void;
  onError: (message: string) => void;
  onTab: (tab: "providers" | "settings") => void;
}) {
  const [statuses, setStatuses] = useState<KeyStatus[]>(initialStatuses);
  const [connectId, setConnectId] = useState<number | null>(null);
  const [loggingId, setLoggingId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<{ kind: "revoke" | "delete"; key: KeyRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const count = (s: KeyStatus) => keys.filter((k) => keyStatus(k) === s).length;
  const visible = keys.filter((k) => statuses.includes(keyStatus(k)));
  const activeKeys = keys.filter((k) => keyStatus(k) === "active");
  const ready = (k: KeyRow) => k.allowed_providers.some((p) => configured.includes(p));

  const changeStatuses = (next: KeyStatus[]) => {
    setStatuses(next);
    try {
      localStorage.setItem(REMEMBER, next.includes("revoked") ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };

  const runConfirmed = () => {
    if (!pending) return;
    setBusy(true);
    setConfirmError(null);
    (pending.kind === "revoke" ? api.revokeKey(pending.key.id) : api.deleteKey(pending.key.id))
      .then(() => {
        setPending(null);
        refresh();
      })
      .catch((e: Error) => setConfirmError(e.message))
      .finally(() => setBusy(false));
  };

  const ask = (kind: "revoke" | "delete", key: KeyRow) => {
    setConfirmError(null);
    setPending({ kind, key });
  };

  const actions: KeyActions = {
    connectId,
    loggingId,
    onConnect: (id) => setConnectId(connectId === id ? null : id),
    onLogging: (id) => setLoggingId(loggingId === id ? null : id),
    onPause: (k) =>
      api
        .updateKey(k.id, { allow_live: !k.allow_live })
        .then(refresh)
        .catch((e: Error) => onError(e.message)),
    onRevoke: (k) => ask("revoke", k),
    onDelete: (k) => ask("delete", k),
    canResume: ready,
    masterText: ws?.content_logging?.enabled,
    masterImages: ws?.image_logging?.enabled,
    retentionDays: ws?.content_logging?.retention_days ?? 30,
    configured,
    onChange: refresh,
  };

  const hasRequests = keys.some((k) => k.requests > 0);
  const firstActive = activeKeys[0];
  const parts = [`${count("active")} active`, count("revoked") ? `${count("revoked")} revoked` : "", count("deleted") ? `${count("deleted")} deleted` : ""].filter(Boolean);

  return (
    <div className="space-y-4">
      {(!hasRequests || activeKeys.length === 0) && (
        <Checklist
          hasProvider={configured.length > 0}
          hasKey={activeKeys.length > 0}
          hasRequests={hasRequests}
          onProviders={() => onTab("providers")}
          onCreate={() => setCreateOpen(true)}
          onConnect={firstActive ? () => setConnectId(firstActive.id) : undefined}
        />
      )}

      {ws && <LoggingStrip ws={ws} keys={keys} onSettings={() => onTab("settings")} />}

      <section aria-labelledby="keys-title" className="rounded-xl border border-line bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 id="keys-title" className="text-sm font-semibold text-fg">
              Virtual keys
            </h2>
            <span className="text-ui text-fg-muted">{parts.join(" · ")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <KeyStatusFilter value={statuses} onChange={changeStatuses} />
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button variant="primary">
                  <span aria-hidden="true">+</span> Create key
                </Button>
              </DialogTrigger>
              <DialogContent
                placement="right"
                title="Create a virtual key"
                // the one-time secret is shown here: a stray click outside must not close it
                onInteractOutside={(e) => e.preventDefault()}
              >
                <CreateKeyForm
                  framed={false}
                  onCreated={refresh}
                  configuredProviders={configured}
                  members={members}
                  masterText={ws?.content_logging?.enabled}
                  masterImages={ws?.image_logging?.enabled}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <div className="p-4">
          <KeysTable
            keys={visible}
            a={actions}
            empty={keys.length === 0 ? "No keys yet. Create one to get started." : "No keys with these statuses. Tick another status above."}
          />
          {statuses.includes("deleted") && count("deleted") > 0 && (
            <p className="mt-3 text-xs text-fg-muted">
              Deleted keys can no longer be used or changed. Their requests and costs stay in the dashboard.
            </p>
          )}
        </div>
      </section>

      {pending && (
        <ConfirmDialog
          title={pending.kind === "revoke" ? "Revoke this key?" : "Delete this key?"}
          confirmLabel={pending.kind === "revoke" ? "Revoke key" : "Delete key"}
          busy={busy}
          error={confirmError}
          onConfirm={runConfirmed}
          onCancel={() => setPending(null)}
        >
          <p>
            <span className="font-medium text-fg">{pending.key.label}</span>{" "}
            <span className="font-mono text-xs">({pending.key.key_prefix}…)</span>
          </p>
          {pending.kind === "revoke" ? (
            <p>
              Apps using this key will stop working immediately (they get a 401). Revoking cannot be undone. Its usage
              history stays in the dashboard.
            </p>
          ) : (
            <p>
              The key moves to <strong>Deleted keys</strong> and cannot be used or changed again. Its usage history and
              costs stay in the dashboard.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
