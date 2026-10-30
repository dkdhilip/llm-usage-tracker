import { Fragment, useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, type KeyRow, type WorkspaceDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
import { ConnectPanel } from "../components/ConnectPanel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { num, relTime, usd } from "../lib/format";
import { CostCell } from "../components/CostCell";
import { ProvidersCard } from "./workspace/ProvidersCard";
import { MembersCard } from "./workspace/MembersCard";
import { CreateKeyForm } from "./workspace/CreateKeyForm";
import { ContentLoggingCard } from "./workspace/ContentLoggingCard";
import { SettingsCard } from "./workspace/SettingsCard";
import { KeyLoggingEditor, KeyLoggingPill } from "./workspace/KeyLogging";

// ---------- page ----------
export function Workspace() {
  const { isWorkspaceAdmin, loading, logout } = useAuth();
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [defaultCap, setDefaultCap] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [connectKeyId, setConnectKeyId] = useState<number | null>(null);
  const [loggingKeyId, setLoggingKeyId] = useState<number | null>(null);
  // Revoked keys are tucked away by default (nothing is deleted: their usage history stays in the dashboard).
  // The choice is remembered in this browser.
  const [showRevoked, setShowRevoked] = useState<boolean>(() => {
    try {
      return localStorage.getItem("showRevokedKeys") === "1";
    } catch {
      return false; // storage blocked
    }
  });
  const [showDeleted, setShowDeleted] = useState(false);
  const [pending, setPending] = useState<{ kind: "revoke" | "delete"; key: KeyRow } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const ask = (kind: "revoke" | "delete", key: KeyRow) => {
    setConfirmError(null);
    setPending({ kind, key });
  };
  const toggleRevoked = () =>
    setShowRevoked((v) => {
      try {
        localStorage.setItem("showRevokedKeys", v ? "0" : "1");
      } catch {
        /* storage blocked */
      }
      return !v;
    });

  const refresh = useCallback(() => {
    api.getWorkspace().then(setWs).catch((e: Error) => setError(e.message));
    api.listKeys().then(setKeys).catch((e: Error) => setError(e.message));
    api.getAccount().then((a) => setDefaultCap(a.live_cap_default_usd)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <div className="mx-auto max-w-md p-6 text-sm text-fg-subtle">Loading…</div>;
  }
  if (!isWorkspaceAdmin) return <Navigate to="/dashboard" replace />;

  const providers = ws?.providers ?? [];
  const configured = providers.filter((p) => p.configured).map((p) => p.provider);
  const members = (ws?.members ?? []).filter((m) => m.role === "member");
  const deletedKeys = keys.filter((k) => k.deleted_at);
  const liveKeys = keys.filter((k) => !k.deleted_at); // deleted keys have their own section below
  const activeKeys = liveKeys.filter((k) => !k.revoked_at);
  const revokedCount = liveKeys.length - activeKeys.length;
  const visibleKeys = showRevoked ? liveKeys : activeKeys;
  const runConfirmed = () => {
    if (!pending) return;
    setConfirmBusy(true);
    setConfirmError(null);
    (pending.kind === "revoke" ? api.revokeKey(pending.key.id) : api.deleteKey(pending.key.id))
      .then(() => {
        setPending(null);
        refresh();
      })
      .catch((e: Error) => setConfirmError(e.message))
      .finally(() => setConfirmBusy(false));
  };
  const keyLiveReady = (k: KeyRow) => k.allowed_providers.some((p) => configured.includes(p));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-fg">{ws?.name ?? "Workspace"}</h1>
          <div className="text-xs text-fg-subtle">Workspace Admin</div>
        </div>
        <button
          onClick={() => {
            void logout();
            setKeys([]);
          }}
          className="text-sm text-fg-muted hover:underline inline-flex min-h-7 items-center"
        >
          Sign out
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="min-w-0 space-y-4">
          <ProvidersCard
            providers={providers}
            defaultCap={defaultCap}
            onChange={refresh}
          />
          {ws && <ContentLoggingCard ws={ws} onChange={refresh} />}
          {ws && <SettingsCard ws={ws} onChange={refresh} />}
        </div>
        <div className="min-w-0 space-y-4">
          <CreateKeyForm
            onCreated={refresh}
            configuredProviders={configured}
            members={members}
            masterText={ws?.content_logging?.enabled}
            masterImages={ws?.image_logging?.enabled}
          />
          {ws && <MembersCard ws={ws} onChange={refresh} />}
        </div>
      </div>

      <Card
        title={`Virtual keys (${activeKeys.length})`}
        right={
          revokedCount > 0 ? (
            <button
              type="button"
              onClick={toggleRevoked}
              aria-pressed={showRevoked}
              className="text-xs text-brand-600 hover:underline inline-flex min-h-7 items-center"
            >
              {showRevoked ? `Hide revoked keys (${revokedCount})` : `Show revoked keys (${revokedCount})`}
            </button>
          ) : undefined
        }
      >
        <div className="relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" tabIndex={0} role="region" aria-label="Virtual keys table">
          <table className="w-full min-w-[60rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-subtle">
                <th className="py-2 pr-4">Label</th>
                <th className="py-2 pr-4">Prefix</th>
                <th className="py-2 pr-4">Assigned</th>
                <th className="py-2 pr-4">Allowed providers</th>
                <th className="py-2 pr-4">Logging</th>
                <th className="py-2 pr-4 text-center">Live</th>
                <th className="py-2 pr-4 text-right">Requests</th>
                <th className="py-2 pr-4 text-right">Cost</th>
                <th className="py-2 pr-4">Budget</th>
                <th className="py-2 pr-4">Last used</th>
                <th className="py-2 pr-0 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleKeys.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-fg-subtle">
                    {keys.length === 0
                      ? deletedKeys.length > 0 && liveKeys.length === 0
                        ? "No keys — create one above. Deleted keys are listed below."
                        : "No keys yet — create one above."
                      : "No active keys — create one above. Revoked keys are hidden."}
                  </td>
                </tr>
              )}
              {visibleKeys.map((k) => (
                <Fragment key={k.id}>
                <tr
                  className={`border-b border-line last:border-0 ${
                    k.revoked_at ? "text-fg-subtle" : ""
                  }`}
                >
                  <td className="py-2 pr-4 font-medium">{k.label}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{k.key_prefix}…</td>
                  <td className="py-2 pr-4 text-xs text-fg-subtle">
                    {k.assigned_username ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {k.allowed_providers.map((p) => (
                        <span
                          key={p}
                          className="rounded bg-fill px-1.5 py-0.5 text-[11px] text-fg-muted"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-4" data-testid={`key-logging-${k.id}`}>
                    <KeyLoggingPill
                      k={k}
                      masterText={ws?.content_logging?.enabled}
                      masterImages={ws?.image_logging?.enabled}
                    />
                  </td>
                  <td className="py-2 pr-4 text-center">
                    {k.revoked_at ? (
                      <span className="text-xs text-fg-subtle">—</span>
                    ) : (
                      <button
                        onClick={() =>
                          api
                            .updateKey(k.id, { allow_live: !k.allow_live })
                            .then(refresh)
                            .catch((e: Error) => setError(e.message))
                        }
                        disabled={!keyLiveReady(k) && !k.allow_live}
                        title={
                          k.allow_live
                            ? "Pause this key (its requests will return 403 until re-enabled)"
                            : keyLiveReady(k)
                              ? "Resume live calls for this key"
                              : "No provider key for this key's providers — add one under Provider keys"
                        }
                        className={`rounded px-2 py-0.5 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${
                          k.allow_live
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
                            : "bg-fill text-fg-subtle"
                        }`}
                      >
                        {k.allow_live ? "LIVE" : keyLiveReady(k) ? "paused" : "no key"}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(k.requests)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums"><CostCell cost={k.cost} requests={k.requests} unpriced={k.unpriced_requests} /></td>
                  <td className="py-2 pr-4">
                    {k.monthly_budget_usd == null ? (
                      <span className="text-xs text-fg-subtle">unlimited</span>
                    ) : (
                      <div className="w-32">
                        <div className="flex justify-between text-[10px] text-fg-subtle">
                          <span>{usd(k.spend_period)}</span>
                          <span>
                            {usd(k.monthly_budget_usd)}
                            {k.budget_period === "custom" ? "" : `/${k.budget_period[0]}`}
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 rounded bg-fill">
                          <div
                            className={`h-1.5 rounded ${
                              k.spend_period >= k.monthly_budget_usd
                                ? "bg-red-500"
                                : "bg-brand-500"
                            }`}
                            style={{
                              width: `${Math.min(
                                100,
                                k.monthly_budget_usd > 0
                                  ? (k.spend_period / k.monthly_budget_usd) * 100
                                  : 100,
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-xs text-fg-subtle">{relTime(k.last_used_at)}</td>
                  <td className="py-2 pr-0 text-right">
                    {k.revoked_at ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs">revoked</span>
                        <button
                          onClick={() => ask("delete", k)}
                          title="Move this revoked key to Deleted keys (its usage history is kept)"
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setLoggingKeyId(loggingKeyId === k.id ? null : k.id)}
                          aria-expanded={loggingKeyId === k.id}
                          title="Choose whether this key's prompts, responses and images are logged"
                          className="rounded border border-line px-2 py-1 text-xs text-fg-muted hover:bg-fill"
                        >
                          Logging
                        </button>
                        <button
                          onClick={() => setConnectKeyId(connectKeyId === k.id ? null : k.id)}
                          aria-expanded={connectKeyId === k.id}
                          title="How to use this key from OpenAI, Anthropic or Gemini code"
                          className="rounded border border-line px-2 py-1 text-xs text-fg-muted hover:bg-fill"
                        >
                          Connect
                        </button>
                        <button
                          onClick={() => ask("revoke", k)}
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {loggingKeyId === k.id && !k.revoked_at && (
                  <tr className="border-b border-line bg-surface-2">
                    <td colSpan={11} className="px-4 py-3">
                      <KeyLoggingEditor
                        k={k}
                        masterText={ws?.content_logging?.enabled}
                        masterImages={ws?.image_logging?.enabled}
                        retentionDays={ws?.content_logging?.retention_days ?? 30}
                        onChange={refresh}
                      />
                    </td>
                  </tr>
                )}
                {connectKeyId === k.id && !k.revoked_at && (
                  <tr className="border-b border-line bg-surface-2">
                    <td colSpan={11} className="px-4 py-4">
                      <ConnectPanel
                        keyInfo={{ allowed_providers: k.allowed_providers, allow_live: k.allow_live, expires_at: k.expires_at }}
                        configuredProviders={configured}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {deletedKeys.length > 0 && (
        <Card
          title={`Deleted keys (${deletedKeys.length})`}
          right={
            <button
              type="button"
              onClick={() => setShowDeleted((v) => !v)}
              aria-expanded={showDeleted}
              className="text-xs text-brand-600 hover:underline inline-flex min-h-7 items-center"
            >
              {showDeleted ? "Hide deleted keys" : "Show deleted keys"}
            </button>
          }
        >
          {showDeleted ? (
            <div className="relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" tabIndex={0} role="region" aria-label="Deleted keys table">
              <table className="w-full min-w-[32rem] text-sm text-fg-subtle">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide">
                    <th className="py-2 pr-4">Label</th>
                    <th className="py-2 pr-4">Prefix</th>
                    <th className="py-2 pr-4 text-right">Requests</th>
                    <th className="py-2 pr-4 text-right">Cost</th>
                    <th className="py-2 pr-0">Deleted</th>
                  </tr>
                </thead>
                <tbody>
                  {deletedKeys.map((k) => (
                    <tr key={k.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4 font-medium">{k.label}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{k.key_prefix}…</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{num(k.requests)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums"><CostCell cost={k.cost} requests={k.requests} unpriced={k.unpriced_requests} /></td>
                      <td className="py-2 pr-0 text-xs">{relTime(k.deleted_at ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-fg-subtle">
                Deleted keys can no longer be used or changed. Their requests and costs stay in the dashboard.
              </p>
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">Deleted keys are hidden. Their usage history is kept.</p>
          )}
        </Card>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === "revoke" ? "Revoke this key?" : "Delete this key?"}
          confirmLabel={pending.kind === "revoke" ? "Revoke key" : "Delete key"}
          busy={confirmBusy}
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
