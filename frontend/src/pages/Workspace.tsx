import { useCallback, useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api, type KeyRow, type WorkspaceDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { keyStatus } from "../lib/keyOptions";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { Tab, TabList, TabPanel, Tabs } from "../components/ui/Tabs";
import { ContentLoggingCard } from "./workspace/ContentLoggingCard";
import { KeysTab } from "./workspace/KeysTab";
import { MembersCard } from "./workspace/MembersCard";
import { ProvidersCard } from "./workspace/ProvidersCard";
import { SettingsCard } from "./workspace/SettingsCard";

const TABS = ["keys", "providers", "team", "settings"] as const;
type TabId = (typeof TABS)[number];

export function Workspace() {
  const { isWorkspaceAdmin, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [defaultCap, setDefaultCap] = useState(5);
  const [error, setError] = useState<string | null>(null);

  // The tab is in the URL (?tab=), so a section can be linked to and survives a reload. Keys is the default.
  const asked = params.get("tab");
  const tab: TabId = TABS.find((t) => t === asked) ?? "keys";
  const setTab = (next: TabId) => setParams(next === "keys" ? {} : { tab: next });

  const refresh = useCallback(() => {
    setError(null);
    api.getWorkspace().then(setWs).catch((e: Error) => setError(e.message));
    api.listKeys().then(setKeys).catch((e: Error) => setError(e.message));
    api.getAccount().then((a) => setDefaultCap(a.live_cap_default_usd)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <div className="mx-auto max-w-md p-6 text-sm text-fg-muted">Loading…</div>;
  }
  if (!isWorkspaceAdmin) return <Navigate to="/dashboard" replace />;

  const providers = ws?.providers ?? [];
  const configured = providers.filter((p) => p.configured).map((p) => p.provider);
  const members = (ws?.members ?? []).filter((m) => m.role === "member");
  const activeCount = keys.filter((k) => keyStatus(k) === "active").length;

  return (
    <div>
      <PageHeader
        title={ws?.name ?? "Workspace"}
        description={
          <Badge variant="brand" className="align-middle">
            Workspace Admin
          </Badge>
        }
      />

      {error && (
        <InlineAlert
          tone="error"
          title="Couldn't load the workspace"
          className="mb-4"
          action={
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </InlineAlert>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabList aria-label="Workspace sections">
          <Tab value="keys" count={keys.length ? activeCount : undefined}>
            Keys
          </Tab>
          <Tab value="providers">Providers</Tab>
          <Tab value="team" count={members.length || undefined}>
            Team
          </Tab>
          <Tab value="settings">Settings</Tab>
        </TabList>

        <TabPanel value="keys">
          <KeysTab
            ws={ws}
            keys={keys}
            configured={configured}
            members={members}
            refresh={refresh}
            onError={setError}
            onTab={setTab}
          />
        </TabPanel>
        <TabPanel value="providers" className="max-w-3xl">
          <ProvidersCard providers={providers} defaultCap={defaultCap} onChange={refresh} />
        </TabPanel>
        <TabPanel value="team" className="max-w-3xl">
          {ws && <MembersCard ws={ws} onChange={refresh} />}
        </TabPanel>
        <TabPanel value="settings" className="max-w-3xl space-y-4">
          {ws && <ContentLoggingCard ws={ws} onChange={refresh} />}
          {ws && <SettingsCard ws={ws} onChange={refresh} />}
        </TabPanel>
      </Tabs>
    </div>
  );
}
