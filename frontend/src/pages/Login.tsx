import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { InlineAlert } from "../components/ui/InlineAlert";
import { USERNAME_PATTERN, USERNAME_RULES } from "../lib/validation";

export function Login() {
  const { login, signup, authenticated, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (authenticated) return <Navigate to="/dashboard" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signup") await signup(username.trim().toLowerCase(), password);
      else await login(username.trim().toLowerCase(), password);
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // the form-level error describes both fields (it is about the pair), on top of each field's own hint
  const failed = (describedBy?: string) => ({
    "aria-describedby": [describedBy, err ? "auth-error" : null].filter(Boolean).join(" ") || undefined,
    ...(err ? { "aria-invalid": true as const } : {}),
  });

  return (
    <div className="mx-auto max-w-md pt-4 sm:pt-10">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{mode === "signup" ? "Create an account" : "Sign in"}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {mode === "signup"
            ? "Create an account, then start a workspace for your team or join one with an invite code."
            : "Sign in to your workspace — usage, virtual keys, and cost tracking."}
        </p>
        {sessionExpired && (
          <InlineAlert tone="warning" role="status" className="mt-4">
            Your session expired. Please sign in again.
          </InlineAlert>
        )}
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field
            label="Username"
            hint={
              mode === "signup" ? (
                <span data-testid="username-rules">3-32 characters: letters, digits, . _ - (an email address won't work here)</span>
              ) : undefined
            }
          >
            {(c) => (
              <Input
                {...c}
                {...failed(c["aria-describedby"])}
                type="text"
                autoComplete="username"
                required
                minLength={3}
                maxLength={32}
                pattern={USERNAME_PATTERN}
                title={USERNAME_RULES}
                className="h-10"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
          </Field>
          <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
            {(c) => (
              <Input
                {...c}
                {...failed(c["aria-describedby"])}
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={8}
                className="h-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {err && (
            <InlineAlert id="auth-error" tone="error">
              {err}
            </InlineAlert>
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={busy || username.trim().length < 3 || password.length < 8}
          >
            {busy ? "Working…" : mode === "signup" ? "Sign up" : "Sign in"}
          </Button>
        </form>
        <div className="mt-4 border-t border-line pt-4">
          <Button
            variant="ghost"
            className="-ml-3"
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setErr(null);
            }}
          >
            {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
          </Button>
          <p className="mt-2 text-xs text-fg-muted">
            No password reset yet — use a unique password and pick a username you'll remember.
          </p>
        </div>
      </div>
    </div>
  );
}
