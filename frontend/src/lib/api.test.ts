import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, csrfToken, setSessionExpiredHandler } from "./api";

function mockFetch() {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ authenticated: false, user: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof mockFetch>): Record<string, string> {
  const init = fn.mock.calls[0][1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe("CSRF header on API requests", () => {
  beforeEach(() => {
    document.cookie = "csrf_token=tok-123; path=/";
  });
  afterEach(() => {
    document.cookie = "csrf_token=; path=/; max-age=0";
    vi.unstubAllGlobals();
  });

  it("reads the readable csrf_token cookie", () => {
    expect(csrfToken()).toBe("tok-123");
  });

  it("sends X-CSRF-Token on an unsafe request (POST)", async () => {
    const fn = mockFetch();
    await api.logout();
    expect(sentHeaders(fn)["X-CSRF-Token"]).toBe("tok-123");
  });

  it("sends X-CSRF-Token on DELETE too", async () => {
    const fn = mockFetch();
    await api.deleteAccount();
    expect(sentHeaders(fn)["X-CSRF-Token"]).toBe("tok-123");
  });

  it("does not send it on a safe request (GET)", async () => {
    const fn = mockFetch();
    await api.me();
    expect(sentHeaders(fn)["X-CSRF-Token"]).toBeUndefined();
  });

  it("omits the header (does not send 'null') when there is no cookie", async () => {
    document.cookie = "csrf_token=; path=/; max-age=0";
    const fn = mockFetch();
    await api.logout();
    expect("X-CSRF-Token" in sentHeaders(fn)).toBe(false);
  });
});

// ----------------------------------------------------------------------------- expired sessions

type Scripted = { status: number; body?: unknown };

/** A fetch whose responses are scripted in order; anything unscripted is a loud 500 so a stray request can't pass. */
function scriptedFetch(...responses: Scripted[]) {
  const queue = [...responses];
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift() ?? { status: 500, body: { detail: "unscripted request" } };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const sent = (fn: ReturnType<typeof scriptedFetch>) =>
  fn.mock.calls.map(([url, init]) => `${(init?.method ?? "GET").toUpperCase()} ${url}`);

const CSRF_DETAIL = "CSRF token missing or invalid - reload the page and try again";

describe("expired sessions", () => {
  let expired: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    expired = vi.fn();
    setSessionExpiredHandler(expired);
    document.cookie = "csrf_token=tok-123; path=/";
  });
  afterEach(() => {
    setSessionExpiredHandler(null);
    document.cookie = "csrf_token=; path=/; max-age=0";
    vi.unstubAllGlobals();
  });

  it("a 401 from the session API reports the expiry once and still rejects with the server's message", async () => {
    scriptedFetch({ status: 401, body: { detail: "sign in required" } });
    await expect(api.workspaceProviders()).rejects.toThrow("sign in required");
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("a 401 on login or signup is a wrong password, not an expired session", async () => {
    scriptedFetch({ status: 401, body: { detail: "invalid username or password" } });
    await expect(api.login("alice", "wrong-password")).rejects.toThrow("invalid username or password");
    scriptedFetch({ status: 401, body: { detail: "nope" } });
    await expect(api.signup("alice", "wrong-password")).rejects.toThrow("nope");
    expect(expired).not.toHaveBeenCalled();
  });

  it("a 401 from the /v1 virtual-key API (the Playground) is a bad key, not an expired session", async () => {
    scriptedFetch({ status: 401, body: { detail: "invalid or revoked virtual key" } });
    await expect(api.inspectKey("vk_revoked")).rejects.toThrow("invalid or revoked virtual key");
    scriptedFetch({ status: 401, body: { detail: "invalid or revoked virtual key" } });
    await expect(api.proxyChat({ provider: "openai", model: "m", prompt: "hi" }, "vk_revoked")).rejects.toThrow();
    expect(expired).not.toHaveBeenCalled();
  });

  it("an ordinary 403 (not an admin, no workspace, key paused) is a real answer: no sign-out, no retry", async () => {
    const fn = scriptedFetch({ status: 403, body: { detail: "workspace admin only" } });
    await expect(api.workspaceProviders()).rejects.toThrow("workspace admin only");
    expect(expired).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a CSRF rejection re-syncs through /api/auth/me and retries the request once", async () => {
    const fn = scriptedFetch(
      { status: 403, body: { detail: CSRF_DETAIL } },
      { status: 200, body: { authenticated: true, user: null } },
      { status: 200, body: { id: 7, name: "w" } },
    );
    await expect(api.createWorkspace("w")).resolves.toMatchObject({ id: 7 });
    expect(sent(fn)).toEqual(["POST /api/workspace", "GET /api/auth/me", "POST /api/workspace"]);
    expect(expired).not.toHaveBeenCalled();
  });

  it("a CSRF rejection for a session that is really gone reports the expiry instead of retrying", async () => {
    const fn = scriptedFetch(
      { status: 403, body: { detail: CSRF_DETAIL } },
      { status: 200, body: { authenticated: false, user: null } },
    );
    await expect(api.createWorkspace("w")).rejects.toThrow("CSRF token");
    expect(expired).toHaveBeenCalledTimes(1);
    expect(sent(fn)).toEqual(["POST /api/workspace", "GET /api/auth/me"]); // not retried
  });

  it("a CSRF rejection that persists after the retry gives up (no loop)", async () => {
    const fn = scriptedFetch(
      { status: 403, body: { detail: CSRF_DETAIL } },
      { status: 200, body: { authenticated: true, user: null } },
      { status: 403, body: { detail: CSRF_DETAIL } },
      { status: 200, body: { authenticated: true, user: null } }, // would only be consumed by a second retry
    );
    await expect(api.createWorkspace("w")).rejects.toThrow("CSRF token");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(expired).not.toHaveBeenCalled();
  });

  it("a session request whose path carries a query string still counts as a session request", async () => {
    scriptedFetch({ status: 401, body: { detail: "sign in required" } });
    await expect(api.integrationGuide("hosted")).rejects.toThrow("sign in required");
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
