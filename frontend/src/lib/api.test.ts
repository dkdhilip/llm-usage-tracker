import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, csrfToken } from "./api";

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
