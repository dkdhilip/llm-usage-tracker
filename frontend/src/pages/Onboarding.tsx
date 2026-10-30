import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { Card } from "../components/Card";
import { Field, Input } from "../components/ui/Field";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";

export function Onboarding() {
  const { inWorkspace, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<null | "create" | "join">(null);
  const [err, setErr] = useState<string | null>(null);

  if (inWorkspace) return <Navigate to="/dashboard" replace />;

  async function run(kind: "create" | "join", fn: () => Promise<unknown>) {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
      await refresh();
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Get started" description="Create a workspace for your team, or join one you were invited to." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Create a workspace">
          <p className="mb-4 text-sm text-fg-muted">
            You become the <strong className="text-fg">Workspace Admin</strong> — issue virtual keys, invite Team Members, and
            see workspace-wide usage.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run("create", () => api.createWorkspace(name.trim()));
            }}
          >
            <Field label="Workspace name">
              {(c) => (
                <Input {...c} required minLength={1} maxLength={80} className="h-10" placeholder="Acme Inc" value={name} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy !== null || !name.trim()}>
              {busy === "create" ? "Creating…" : "Create workspace"}
            </Button>
          </form>
        </Card>

        <Card title="Join a workspace">
          <p className="mb-4 text-sm text-fg-muted">
            Paste the invite code your Workspace Admin sent you. You join as a <strong className="text-fg">Team Member</strong>{" "}
            and see only the keys assigned to you.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run("join", () => api.joinWorkspace(code.trim()));
            }}
          >
            <Field label="Invite code">
              {(c) => (
                <Input {...c} required minLength={1} maxLength={64} className="h-10 font-mono" placeholder="paste code" value={code} onChange={(e) => setCode(e.target.value)} />
              )}
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy !== null || !code.trim()}>
              {busy === "join" ? "Joining…" : "Join workspace"}
            </Button>
          </form>
        </Card>
      </div>
      {err && (
        <InlineAlert tone="error" className="mt-4">
          {err}
        </InlineAlert>
      )}
    </div>
  );
}
