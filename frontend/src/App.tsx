import { lazy, Suspense, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Button } from "./components/ui/Button";
import { InlineAlert } from "./components/ui/InlineAlert";

// Each page is loaded when it is first visited, so the first screen (sign in) does not carry the charts, the request
// inspector or the workspace tools. Pages are named exports, hence the small adapter.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Dashboard = page(() => import("./pages/Dashboard"), "Dashboard");
const Requests = page(() => import("./pages/Requests"), "Requests");
const Playground = page(() => import("./pages/Playground"), "Playground");
const Workspace = page(() => import("./pages/Workspace"), "Workspace");
const Account = page(() => import("./pages/Account"), "Account");
const Onboarding = page(() => import("./pages/Onboarding"), "Onboarding");

// The design-system preview exists only in builds made with VITE_STYLEGUIDE=1; it is dropped from every other build.
const StyleGuide = import.meta.env.VITE_STYLEGUIDE === "1" ? lazy(() => import("./pages/StyleGuide").then((m) => ({ default: m.StyleGuide }))) : null;

function Loading() {
  return (
    <div role="status" className="p-6 text-sm text-fg-muted">
      Loading…
    </div>
  );
}

/** Shown when the session could not be checked because the server is unreachable or failing. The visitor is not
 *  asked to sign in (they may well be signed in); they can retry. */
function ConnectionProblem() {
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-md pt-10">
      <InlineAlert
        tone="error"
        title="Can't reach the server"
        action={
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await refresh();
              setBusy(false);
            }}
          >
            {busy ? "Retrying…" : "Retry"}
          </Button>
        }
      >
        Check your connection. You have not been signed out; try again in a moment.
      </InlineAlert>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, loading } = useAuth();
  if (loading) return <Loading />;
  return authenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function RequireWorkspace({ children }: { children: ReactNode }) {
  const { authenticated, inWorkspace, loading } = useAuth();
  if (loading) return <Loading />;
  if (!authenticated) return <Navigate to="/login" replace />;
  return inWorkspace ? <>{children}</> : <Navigate to="/welcome" replace />;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { isWorkspaceAdmin, loading } = useAuth();
  if (loading) return <Loading />;
  return isWorkspaceAdmin ? <>{children}</> : <Navigate to="/dashboard" replace />;
}

export default function App() {
  const { connectionError, authenticated } = useAuth();
  return (
    <Layout>
      {connectionError && !authenticated ? (
        <ConnectionProblem />
      ) : (
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/welcome"
          element={
            <RequireAuth>
              <Onboarding />
            </RequireAuth>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireWorkspace>
              <Dashboard />
            </RequireWorkspace>
          }
        />
        <Route
          path="/requests"
          element={
            <RequireWorkspace>
              <RequireAdmin>
                <Requests />
              </RequireAdmin>
            </RequireWorkspace>
          }
        />
        <Route
          path="/playground"
          element={
            <RequireWorkspace>
              <RequireAdmin>
                <Playground />
              </RequireAdmin>
            </RequireWorkspace>
          }
        />
        <Route
          path="/workspace"
          element={
            <RequireWorkspace>
              <RequireAdmin>
                <Workspace />
              </RequireAdmin>
            </RequireWorkspace>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <Account />
            </RequireAuth>
          }
        />
        {StyleGuide && (
          <Route
            path="/styleguide"
            element={
              <Suspense fallback={<Loading />}>
                <StyleGuide />
              </Suspense>
            }
          />
        )}
        <Route path="/admin" element={<Navigate to="/workspace" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </Suspense>
      )}
    </Layout>
  );
}
