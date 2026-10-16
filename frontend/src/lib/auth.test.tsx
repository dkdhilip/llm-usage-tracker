import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { api } from "./api";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";

// The whole chain, with the REAL req() and the REAL router wrappers: a 401 from the session API -> api.ts reports it
// -> AuthProvider drops to signed-out -> RequireAuth redirects -> the login page says why.

const ALICE = { id: 1, username: "alice", workspace: null };

type Reply = { status: number; body: unknown };
const json = ({ status, body }: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** URL-routed fetch: `me` is what GET /api/auth/me answers (it can change mid-test); `sessionApi` answers the rest. */
function stubServer(opts: { me: () => Reply; sessionApi?: () => Reply; login?: () => Reply }) {
  const fn = vi.fn(async (url: string) => {
    if (url === "/api/auth/me") return json(opts.me());
    if (url === "/api/auth/login" && opts.login) return json(opts.login());
    if (url === "/api/workspace/providers" && opts.sessionApi) return json(opts.sessionApi());
    return json({ status: 500, body: { detail: `unexpected request: ${url}` } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );
}

const SIGNED_IN: Reply = { status: 200, body: { authenticated: true, user: ALICE } };
const SIGNED_OUT: Reply = { status: 200, body: { authenticated: false, user: null } };
const EXPIRED: Reply = { status: 401, body: { detail: "sign in required" } };

describe("an expired session, end to end", () => {
  beforeEach(() => {
    document.cookie = "csrf_token=tok-123; path=/";
  });
  afterEach(() => {
    document.cookie = "csrf_token=; path=/; max-age=0";
    vi.unstubAllGlobals();
  });

  it("sends a signed-in user to the login page with an explanation when the server says 401", async () => {
    stubServer({ me: () => SIGNED_IN, sessionApi: () => EXPIRED });
    renderAt("/welcome");
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument(); // signed in, on a protected page
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();

    // any later call to the session API now answers 401 (the cookie expired while the tab sat open)
    await act(async () => {
      await api.workspaceProviders().catch(() => undefined);
    });

    expect(await screen.findByText("Your session expired. Please sign in again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument(); // the login form
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument(); // and the protected page is gone
  });

  it("does not claim a session expired for a visitor who was never signed in", async () => {
    stubServer({ me: () => SIGNED_OUT, sessionApi: () => EXPIRED });
    renderAt("/dashboard");
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument(); // redirected, as before

    await act(async () => {
      await api.workspaceProviders().catch(() => undefined); // a stray 401 while signed out
    });
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  it("a wrong password on the login page is an ordinary error, never 'session expired'", async () => {
    const user = userEvent.setup();
    stubServer({
      me: () => SIGNED_OUT,
      login: () => ({ status: 401, body: { detail: "invalid username or password" } }),
    });
    renderAt("/login");
    await user.type(await screen.findByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "wrong-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("invalid username or password")).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  it("clears the explanation once the user signs in again", async () => {
    const user = userEvent.setup();
    let signedIn = true;
    stubServer({
      me: () => (signedIn ? SIGNED_IN : SIGNED_OUT),
      sessionApi: () => EXPIRED,
      login: () => ({ status: 200, body: { authenticated: true, user: ALICE } }),
    });
    renderAt("/welcome");
    await screen.findByRole("heading", { name: "Get started" });
    signedIn = false;
    await act(async () => {
      await api.workspaceProviders().catch(() => undefined);
    });
    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "right-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument(); // signed in again
  });
});
