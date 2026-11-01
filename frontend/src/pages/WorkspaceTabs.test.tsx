import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { api, type KeyRow } from "../lib/api";
import { chooseKeyAction, keyRow } from "../test/workspaceHelpers";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isWorkspaceAdmin: true, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      getWorkspace: vi.fn(), listKeys: vi.fn(), listModelPricing: vi.fn(), getAccount: vi.fn(), integrationGuide: vi.fn(),
      updateKey: vi.fn(), createKey: vi.fn(),
    },
  };
});

const key = (over: Partial<KeyRow>): KeyRow => ({
  id: 1, label: "team-key", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai"],
  allow_live: true, default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null,
  budget_end: null, expires_at: null, spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null,
  requests: 5, total_tokens: 0, cost: 0.5, content_logging_enabled: false, image_logging_enabled: false, ...over,
});

const provider = (name: string, configured: boolean) => ({
  provider: name, configured, source: configured ? ("workspace" as const) : ("none" as const), last4: configured ? "1234" : null,
  monthly_cap_usd: null, spend_this_month: 0,
});

const workspace = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "Acme", role: "admin" as const,
  members: [
    { user_id: 1, username: "admin", role: "admin" as const, assigned_keys: 0, requests: 0, cost: 0 },
    { user_id: 2, username: "samuel", role: "member" as const, assigned_keys: 1, requests: 0, cost: 0 },
  ],
  invites: [], providers: [provider("openai", true), provider("anthropic", false)],
  content_logging: { enabled: true, retention_days: 30, updated_at: null, keys_total: 2, keys_logging: 1, keys_logging_images: 0 },
  image_logging: { enabled: false, updated_at: null, used_bytes: 0, cap_bytes: 50_000_000, max_image_bytes: 2_000_000, max_per_request: 4, global_full: false },
  ...over,
});

function page(url = "/workspace") {
  return render(<MemoryRouter initialEntries={[url]}><Workspace /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.getWorkspace).mockResolvedValue(workspace());
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.listKeys).mockResolvedValue([
    key({ id: 1, label: "prod-openai", content_logging_enabled: true }),
    key({ id: 2, label: "sam-key", assigned_username: "samuel" }),
  ]);
  vi.mocked(api.updateKey).mockResolvedValue({});
});

describe("Workspace tabs", () => {
  it("opens on Keys, with the other sections one tab away and counts on the tabs", async () => {
    page();
    const tabs = await screen.findByRole("tablist", { name: "Workspace sections" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Keys2", "Providers", "Team2", "Settings"]);
    expect(within(tabs).getByRole("tab", { name: /^Keys/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("prod-openai")).toBeInTheDocument();
    expect(screen.queryByText("Provider keys")).toBeNull(); // only the open section is in the page
  });

  it("opens the section named in the URL, and falls back to Keys for an unknown one", async () => {
    const { unmount } = page("/workspace?tab=providers");
    expect(await screen.findByText("Provider keys")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    unmount();
    page("/workspace?tab=nonsense");
    expect(await screen.findByText("prod-openai")).toBeInTheDocument();
  });

  it("switches section with a click or the arrow keys", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("tab", { name: /^Team/ }));
    expect(await screen.findByRole("heading", { name: /^Members/ })).toBeInTheDocument();
    expect(screen.queryByText("prod-openai")).toBeNull();
    screen.getByRole("tab", { name: /^Team/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
  });

  it("names the workspace and the admin role in the page head", async () => {
    page();
    expect(await screen.findByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("Workspace Admin")).toBeInTheDocument();
  });
});

describe("Workspace logging strip", () => {
  it("says whether prompt logging is on, how many keys log, and links to its settings", async () => {
    const user = userEvent.setup();
    page();
    expect(await screen.findByText("1 of 2 keys · Images off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Logging settings" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("says logging is off, and how long stored content is kept once on", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ content_logging: { enabled: false, retention_days: 14, updated_at: null, keys_total: 2, keys_logging: 0, keys_logging_images: 0 } }));
    page();
    expect(await screen.findByText("Stored content is deleted after 14 days when on.")).toBeInTheDocument();
  });
});

describe("Workspace Getting started section", () => {
  const header = (name: RegExp | string) => screen.findByRole("button", { name });

  it("is open for a workspace that is not set up, says what comes next, and its key step opens the drawer", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([]);
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ providers: [provider("openai", false)] }));
    const user = userEvent.setup();
    page();
    const toggle = await header(/^Getting started.*0 of 3 steps done$/);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Next: Add a provider key");
    expect(screen.getByRole("button", { name: "How to connect" })).toBeDisabled(); // no key to connect yet
    await user.click(screen.getByRole("button", { name: "Create your first key" }));
    expect(await screen.findByRole("dialog", { name: "Create a virtual key" })).toBeInTheDocument();
  });

  it("checks off what the workspace already has", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "fresh", requests: 0 })]);
    page();
    await header(/^Getting started.*2 of 3 steps done$/);
    expect(screen.getAllByText("(done)", { exact: false, selector: "span" })).toHaveLength(2); // the provider and the key
    expect(screen.queryByRole("button", { name: "Create your first key" })).toBeNull();
  });

  it("is closed once everything is done, says so, and opens on request", async () => {
    const user = userEvent.setup();
    page(); // a provider, keys, and requests served
    const toggle = await header(/^Getting started.*3 of 3 steps done$/);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/Everything is set up/);
    expect(screen.queryByText("Point your app at the gateway")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Point your app at the gateway")).toBeInTheDocument();
    expect(screen.getAllByText("(done)", { exact: false, selector: "span" })).toHaveLength(3);
  });

  it("remembers whether it was left open or closed", async () => {
    const user = userEvent.setup();
    const first = page();
    await user.click(await header(/^Getting started.*3 of 3/)); // opened by choice
    first.unmount();
    page();
    expect(await header(/^Getting started.*3 of 3/)).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: /^Getting started/ })); // closed by choice
    expect(screen.getByRole("button", { name: /^Getting started/ })).toHaveAttribute("aria-expanded", "false");
    localStorage.getItem("gettingStartedOpen") === "0" || expect.fail("the choice was not stored");
  });

  it("stays closed for an unfinished workspace if that is what the person chose", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([]);
    localStorage.setItem("gettingStartedOpen", "0");
    page();
    expect(await header(/^Getting started.*1 of 3/)).toHaveAttribute("aria-expanded", "false");
  });

  it("never shows 'nothing is done' while the data is still loading (no flash), and no false 'No keys yet'", async () => {
    let resolveWs: (w: ReturnType<typeof workspace>) => void = () => {};
    let resolveKeys: (k: KeyRow[]) => void = () => {};
    vi.mocked(api.getWorkspace).mockReturnValue(new Promise((r) => (resolveWs = r)));
    vi.mocked(api.listKeys).mockReturnValue(new Promise((r) => (resolveKeys = r)));
    page();
    await screen.findByRole("tablist");
    expect(screen.queryByRole("button", { name: /^Getting started/ })).toBeNull();
    expect(screen.queryByText(/steps done/)).toBeNull();
    expect(screen.queryByText("0 active")).toBeNull();
    expect(screen.queryByText(/No keys yet/)).toBeNull();
    resolveWs(workspace());
    await screen.findByText("Prompt logging"); // the workspace is in, the keys are not: still no verdict
    expect(screen.queryByRole("button", { name: /^Getting started/ })).toBeNull();
    resolveKeys([key({ id: 1, label: "prod-openai" })]);
    expect(await header(/^Getting started.*3 of 3/)).toBeInTheDocument();
    expect(await screen.findByText("prod-openai")).toBeInTheDocument();
  });

  it("says the data could not be loaded, instead of 'No keys yet', when the load fails", async () => {
    vi.mocked(api.listKeys).mockRejectedValue(new Error("database unavailable"));
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
    expect(screen.getAllByText("Couldn't load this data.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Getting started/ })).toBeNull();
    expect(screen.queryByText(/No keys yet/)).toBeNull();
  });

  it("brings the key into view and opens its Connect guide from 'How to connect'", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "fresh", requests: 0 })]);
    vi.mocked(api.integrationGuide).mockResolvedValue({ target: "hosted", gateway_url: "https://gw.example.com", targets: { hosted: "https://gw.example.com", local: "http://127.0.0.1:8000" }, general_notes: [], providers: [] } as never);
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "How to connect" }));
    expect(await screen.findByRole("region", { name: "Connect your app" })).toBeInTheDocument();
    await waitFor(() => expect(scroll.mock.instances.some((el) => (el as unknown as HTMLElement).getAttribute?.("data-key-id") === "1")).toBe(true));
    scroll.mockRestore();
  });
});

describe("Workspace keys table", () => {
  it("shows owner, providers and status in words", async () => {
    page();
    await screen.findByText("sam-key");
    const sam = keyRow("sam-key");
    expect(within(sam).getByText("samuel")).toBeInTheDocument();
    expect(within(sam).getByText("OpenAI")).toBeInTheDocument();
    expect(within(sam).getByText("Active")).toBeInTheDocument();
    expect(within(keyRow("prod-openai")).getByText("Unassigned")).toBeInTheDocument();
  });

  it("draws the budget as a bar that turns amber from 80% and red once over, with the words as well", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([
      key({ id: 1, label: "calm", monthly_budget_usd: 100, spend_period: 10 }),
      key({ id: 2, label: "close", monthly_budget_usd: 100, spend_period: 85 }),
      key({ id: 3, label: "over", monthly_budget_usd: 10, spend_period: 12 }),
      key({ id: 4, label: "free", monthly_budget_usd: null }),
    ]);
    page();
    await screen.findByText("calm");
    expect(within(keyRow("calm")).getByText("10%")).toBeInTheDocument();
    expect(within(keyRow("close")).getByText("85%")).toHaveClass("text-warning-fg");
    expect(within(keyRow("over")).getByText("Over budget")).toHaveClass("text-danger-fg");
    expect(within(keyRow("free")).getByText("No limit")).toBeInTheDocument();
    const bar = within(keyRow("close")).getByRole("progressbar", { name: "Budget used by close" });
    expect(bar).toHaveAttribute("aria-valuenow", "85");
  });

  it("pauses and resumes a key from its menu, and says Paused", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("prod-openai");
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "prod-openai", allow_live: false })]); // what the reload returns
    await chooseKeyAction(user, "prod-openai", "Pause key");
    expect(api.updateKey).toHaveBeenCalledWith(1, { allow_live: false });
    await waitFor(() => expect(within(keyRow("prod-openai")).getByText("Paused")).toBeInTheDocument());
    await chooseKeyAction(user, "prod-openai", "Resume key");
    expect(api.updateKey).toHaveBeenLastCalledWith(1, { allow_live: true });
  });

  it("will not resume a key whose providers have no workspace key", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "stuck", allow_live: false, allowed_providers: ["anthropic"] })]);
    const user = userEvent.setup();
    page();
    await screen.findByText("stuck");
    await user.click(within(keyRow("stuck")).getByRole("button", { name: "More actions for stuck" }));
    expect(screen.getByRole("menuitem", { name: "Resume key" })).toHaveAttribute("aria-disabled", "true");
  });

  it("names every key's menu button for the key, so a list of them is not a list of identical buttons", async () => {
    page();
    await screen.findByText("prod-openai");
    expect(screen.getByRole("button", { name: "More actions for prod-openai" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for sam-key" })).toBeInTheDocument();
  });
});

describe("Workspace keys on a phone", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is one card per key, with the same facts and actions and no table", async () => {
    page();
    await screen.findByText("sam-key");
    expect(screen.queryByRole("table")).toBeNull();
    const card = screen.getByText("sam-key").closest("li")!;
    expect(within(card).getByText("samuel")).toBeInTheDocument();
    expect(within(card).getByText("Active")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "More actions for sam-key" })).toBeInTheDocument();
  });
});
