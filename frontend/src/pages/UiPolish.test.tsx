import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Requests } from "./Requests";
import { Workspace } from "./Workspace";
import { UsageByProviderChart } from "../components/UsageByProviderChart";
import { providerColor, shareLabel, PROVIDER_COLORS } from "../lib/chartColors";
import { ThemeProvider } from "../lib/theme";
import { api, type ByModelRow, type RequestContent, type RequestRow } from "../lib/api";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isWorkspaceAdmin: true, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      getWorkspace: vi.fn(),
      listKeys: vi.fn(),
      listModelPricing: vi.fn(),
      getAccount: vi.fn(),
      integrationGuide: vi.fn(),
      clearWorkspaceProviderKey: vi.fn(),
      setWorkspaceProviderKey: vi.fn(),
      models: vi.fn(),
      listRequests: vi.fn(),
      requestContent: vi.fn(),
      requestImageUrl: (u: number, i: number) => `/api/requests/${u}/images/${i}`,
    },
  };
});

afterEach(() => vi.restoreAllMocks());

// ------------------------------------------------------------------------- Requests: no permanent "not stored"

const row = (over: Partial<RequestRow>): RequestRow => ({
  id: 1, ts: "2026-10-20T10:00:00Z", request_id: "req-1", key_id: 1, key_label: "team-key", key_prefix: "vk_abcdefgh",
  provider: "openai", model: "gpt-4o-mini", prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.001,
  cost_source: "configured", latency_ms: 10, status: "success", prompt_preview: null, response_preview: null,
  has_content: false, ...over,
});

const stored: RequestContent = {
  usage_id: 1, retention_days: 30, content_status: "available", kind: "chat", images: [],
  content: { v: 1, kind: "chat", request: { messages: [{ role: "user", text: "what is this" }] }, response: { text: "a cat", summary: "" } },
};

async function openRow(r: RequestRow, content?: RequestContent) {
  vi.mocked(api.models).mockResolvedValue([]);
  vi.mocked(api.listKeys).mockResolvedValue([]);
  vi.mocked(api.listRequests).mockResolvedValue({ items: [r], next_cursor: null, bodies_logged: false, content_logging_enabled: true });
  if (content) vi.mocked(api.requestContent).mockResolvedValue(content);
  const user = userEvent.setup();
  render(<MemoryRouter><Requests /></MemoryRouter>);
  await user.click(await screen.findByText("team-key"));
  await screen.findByText("Request detail");
}

describe("Requests detail panel", () => {
  it("shows only the stored content - no empty 'not stored' boxes underneath it", async () => {
    await openRow(row({ has_content: true }), stored);
    await screen.findByText("a cat");
    expect(screen.queryByText("— not stored —")).toBeNull();
    expect(screen.queryByTestId("legacy-previews")).toBeNull();
    expect(screen.queryByTestId("nothing-stored")).toBeNull();
    expect(screen.getAllByText("Response")).toHaveLength(1); // not duplicated any more
  });

  it("says so once when nothing was stored at all", async () => {
    await openRow(row({ has_content: false }));
    expect((await screen.findByTestId("nothing-stored")).textContent).toMatch(/No prompt or response was stored/);
    expect(screen.queryByText("— not stored —")).toBeNull();
  });

  it("still shows the legacy previews when the old flag produced some", async () => {
    await openRow(row({ prompt_preview: "legacy prompt", response_preview: null }));
    const box = await screen.findByTestId("legacy-previews");
    expect(within(box).getByText("legacy prompt")).toBeTruthy();
    expect(within(box).queryByText("Response preview")).toBeNull(); // only the one that exists
    expect(screen.queryByTestId("nothing-stored")).toBeNull();
  });
});

// ------------------------------------------------------------------ Workspace: clearing a key brings the field back

const ws = (source: "workspace" | "none") => ({
  id: 1, name: "Acme", role: "admin" as const, members: [], invites: [],
  providers: [
    { provider: "openai", configured: source !== "none", source, last4: source === "none" ? null : "1234", monthly_cap_usd: null, spend_this_month: 0 },
    { provider: "anthropic", configured: false, source: "none" as const, last4: null, monthly_cap_usd: null, spend_this_month: 0 },
  ],
});

describe("Workspace provider keys", () => {
  beforeEach(() => {
    vi.mocked(api.listKeys).mockResolvedValue([]);
    vi.mocked(api.listModelPricing).mockResolvedValue([]);
    vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  });

  it("shows the key entry field again right after a key is cleared, without a page refresh", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValueOnce(ws("workspace")).mockResolvedValue(ws("none"));
    vi.mocked(api.clearWorkspaceProviderKey).mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<MemoryRouter><Workspace /></MemoryRouter>);
    await screen.findByText("saved ····1234");
    expect(screen.queryByPlaceholderText("paste openai key")).toBeNull(); // a saved key: no entry field yet

    await user.click(screen.getByRole("button", { name: "clear" }));
    await waitFor(() => expect(api.clearWorkspaceProviderKey).toHaveBeenCalledWith("openai"));
    const input = await screen.findByPlaceholderText("paste openai key"); // back, with no reload
    expect(input).toBeTruthy();
    expect(screen.queryByText("saved ····1234")).toBeNull();
  });

  it("keeps 'replace' working: the field opens, and cancel closes it again", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(ws("workspace"));
    const user = userEvent.setup();
    render(<MemoryRouter><Workspace /></MemoryRouter>);
    await screen.findByText("saved ····1234");
    await user.click(screen.getByRole("button", { name: "replace" }));
    expect(screen.getByPlaceholderText("paste openai key")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByPlaceholderText("paste openai key")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------ charts

const model = (provider: string, tokens: number): ByModelRow => ({ provider, model: `${provider}-m`, requests: 1, total_tokens: tokens, cost: 0 });

describe("Usage by provider chart", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver, which recharts' ResponsiveContainer needs
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderChart = (data: ByModelRow[]) =>
    render(<ThemeProvider><UsageByProviderChart data={data} /></ThemeProvider>);

  it("lists every provider in a legend with tokens and share, largest first (no labels on the ring to collide)", () => {
    renderChart([model("openrouter", 1_000_000), model("anthropic", 3000), model("openai", 2000), model("gemini", 0)]);
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-testid"))).toEqual(["provider-openrouter", "provider-anthropic", "provider-openai"]); // gemini has no usage
    expect(within(items[0]).getByText("99%")).toBeTruthy();
    expect(within(items[1]).getByText("<1%")).toBeTruthy(); // a sliver is still named and readable
    expect(within(items[2]).getByText("<1%")).toBeTruthy();
    expect(screen.getByText("tokens")).toBeTruthy();
  });

  it("shows the empty state with no usage", () => {
    renderChart([]);
    expect(screen.getByText("No usage in this range yet")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("chart colours", () => {
  it("gives each known provider its own colour and unknown ones a stable fallback", () => {
    const known = Object.values(PROVIDER_COLORS);
    expect(new Set(known).size).toBe(known.length);
    expect(providerColor("openai")).toBe(PROVIDER_COLORS.openai);
    expect(providerColor("some-new-provider")).toBe(providerColor("some-new-provider"));
    expect(known).not.toContain(providerColor("some-new-provider"));
  });

  it("formats shares", () => {
    expect(shareLabel(0, 100)).toBe("0%");
    expect(shareLabel(5, 10_000)).toBe("<1%");
    expect(shareLabel(25, 100)).toBe("25%");
    expect(shareLabel(5, 100)).toBe("5.0%");
    expect(shareLabel(1, 0)).toBe("0%");
    expect(shareLabel(995, 1000)).toBe("99%"); // rounds up but must not read 100% beside other providers
    expect(shareLabel(7, 7)).toBe("100%");
  });
});
