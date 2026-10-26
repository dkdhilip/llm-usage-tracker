import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { api, type IntegrationGuideData, type KeyRow } from "../lib/api";

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
      createKey: vi.fn(),
      updateKey: vi.fn(),
      revokeKey: vi.fn(),
      integrationGuide: vi.fn(),
    },
  };
});

const SECRET = "vk_NEWLY_MINTED_SECRET_VALUE_123";

const provider = (name: string, configured: boolean) => ({
  provider: name, configured, source: configured ? ("workspace" as const) : ("none" as const),
  last4: configured ? "0000" : null, monthly_cap_usd: null, spend_this_month: 0,
});

const key = (over: Partial<KeyRow>): KeyRow => ({
  id: 1, label: "team-key", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai", "anthropic"],
  allow_live: true, default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null,
  budget_end: null, expires_at: null, spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null,
  requests: 0, total_tokens: 0, cost: 0, ...over,
});

function guide(): IntegrationGuideData {
  const mk = (p: "openai" | "anthropic" | "gemini", label: string) => ({
    provider: p, label, sdk: "", install: `pip install ${p}`, gateway_url: "https://gw.example.com", base_url: "",
    endpoint: `POST https://gw.example.com/${p}`, env_vars: [], env_file: `${p.toUpperCase()}_API_KEY=vk_...`,
    code: `# ${p} code`, model_example: "", notes: [], requirements: [],
  });
  return {
    target: "hosted", gateway_url: "https://gw.example.com", targets: { hosted: "https://gw.example.com", local: "http://127.0.0.1:8000" },
    general_notes: ["A virtual key is shown only once, when it is created."],
    providers: [mk("openai", "OpenAI"), mk("anthropic", "Anthropic"), mk("gemini", "Gemini")],
  };
}

// The Connect panel is now a short per-provider summary; the long walkthrough (tabs, readiness checklist, notes) is
// behind "Show full setup guide".
async function openFull(user: ReturnType<typeof userEvent.setup>) {
  const summary = await screen.findByRole("region", { name: "Connect your app" });
  await user.click(within(summary).getByRole("button", { name: "Show full setup guide" }));
  return screen.findByRole("region", { name: "Connect your app" });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.getWorkspace).mockResolvedValue({
    id: 1, name: "Acme", role: "admin",
    members: [{ user_id: 1, username: "admin", role: "admin", assigned_keys: 0, requests: 0, cost: 0 }],
    invites: [],
    providers: [provider("openai", true), provider("anthropic", false), provider("openrouter", false), provider("gemini", false)],
  });
  vi.mocked(api.listKeys).mockResolvedValue([
    key({ id: 1, label: "team-key" }),
    key({ id: 2, label: "old-key", revoked_at: "2026-09-01T00:00:00Z" }),
  ]);
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.integrationGuide).mockImplementation(async () => guide());
  vi.mocked(api.createKey).mockResolvedValue({
    id: 3, label: "dev-key", key: SECRET, key_prefix: "vk_NEWLY_MI", allowed_providers: ["openai"], allow_live: true,
    default_provider: "openai", monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null,
    expires_at: null, created_at: "2026-10-13T00:00:00Z",
  });
});

describe("Workspace → Connect your app", () => {
  it("offers Connect on a live key only, and expands/collapses the guide for it", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("team-key")).closest("tr")!;
    expect(within((await screen.findByText("old-key")).closest("tr")!).queryByRole("button", { name: "Connect" })).toBeNull(); // revoked

    expect(screen.queryByRole("region", { name: "Connect your app" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("region", { name: "Connect your app" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Connect" })).toHaveAttribute("aria-expanded", "true");

    await user.click(within(row).getByRole("button", { name: "Connect" }));
    expect(screen.queryByRole("region", { name: "Connect your app" })).toBeNull();
  });

  it("reflects THAT key's readiness: allowed providers, live state, and the workspace's credentials", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within((await screen.findByText("team-key")).closest("tr")!).getByRole("button", { name: "Connect" }));
    const region = await openFull(user);

    await screen.findByText("# openai code");
    const ok = (re: RegExp) => within(region).getByText(re).closest("li")!.getAttribute("data-ok");
    expect(ok(/OpenAI is enabled/)).toBe("true");
    expect(ok(/Live calls are on/)).toBe("true");
    expect(ok(/holds a real OpenAI credential/)).toBe("true");

    await user.click(within(region).getByRole("tab", { name: "Anthropic" })); // key allows it, workspace has no credential
    expect(ok(/Anthropic is enabled/)).toBe("true");
    expect(ok(/holds a real Anthropic credential/)).toBe("false");

    await user.click(within(region).getByRole("tab", { name: "Gemini" })); // the key doesn't allow Gemini at all
    expect(ok(/Gemini is enabled/)).toBe("false");
  });

  it("shows the guide right under a newly created key — and the secret appears ONLY in the one-time box", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText(/Label — e\.g\./), "dev-key");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    const onceBox = await screen.findByText(/shown only once/i, { selector: "div" });
    expect(onceBox).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument(); // displayed exactly once, for copying

    const region = await screen.findByRole("region", { name: "Connect your app" });
    await within(region).findByTestId("connect-openai"); // the short version: only this key's provider
    expect(within(region).queryByTestId("connect-anthropic")).toBeNull();
    expect(within(region).queryByTestId("connect-gemini")).toBeNull();
    expect(region.textContent).not.toContain(SECRET); // never threaded into the snippets
    expect(region.textContent).toContain("vk_...");
    expect(document.body.textContent!.split(SECRET).length - 1).toBe(1); // one occurrence on the whole page
    await waitFor(() => expect(api.integrationGuide).toHaveBeenCalledWith("hosted"));
    const full = await openFull(user); // and the long guide still opens on the key's first enabled provider
    await within(full).findByText("# openai code");
    expect(within(full).getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
    expect(full.textContent).not.toContain(SECRET);
  });

  it("starts the guide afresh for each newly created key (its first enabled provider, not the previous key's tab)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText(/Label — e\.g\./), "first");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    let region = await screen.findByRole("region", { name: "Connect your app" });
    await within(region).findByTestId("connect-openai");
    region = await openFull(user);
    await within(region).findByText("# openai code");
    expect(within(region).getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(region).getByRole("tab", { name: "Gemini" })); // the developer wandered to another tab

    vi.mocked(api.createKey).mockResolvedValueOnce({
      id: 4, label: "second", key: "vk_SECOND_SECRET_456", key_prefix: "vk_SECOND_S", allowed_providers: ["anthropic"], allow_live: true,
      default_provider: "anthropic", monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null,
      expires_at: null, created_at: "2026-10-13T00:01:00Z",
    });
    await user.type(screen.getByPlaceholderText(/Label — e\.g\./), "second");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    await screen.findByText("vk_SECOND_SECRET_456");
    region = await screen.findByRole("region", { name: "Connect your app" });
    await within(region).findByTestId("connect-anthropic"); // the new key's panel starts afresh, short again
    expect(within(region).queryByTestId("connect-openai")).toBeNull();
    region = await openFull(user);
    await within(region).findByText("# anthropic code");
    expect(within(region).getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
    expect(within(region).getByRole("tab", { name: "Gemini" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows an expired key as not ready in its Connect panel (and a still-valid expiry as fine)", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([
      key({ id: 1, label: "lapsed-key", expires_at: "2020-01-01T00:00:00Z" }),
      key({ id: 2, label: "dated-key", expires_at: "2999-01-01T00:00:00Z" }),
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.click(within((await screen.findByText("lapsed-key")).closest("tr")!).getByRole("button", { name: "Connect" }));
    let region = await openFull(user);
    await within(region).findByText("# openai code");
    expect(within(region).getByText(/This key expired on/).closest("li")!.getAttribute("data-ok")).toBe("false");
    expect(within(region).getByText(/expired key is refused with a 401/)).toBeInTheDocument();

    await user.click(within((await screen.findByText("dated-key")).closest("tr")!).getByRole("button", { name: "Connect" }));
    region = await openFull(user);
    await within(region).findByText("# openai code");
    expect(within(region).getByText(/The key has not expired/).closest("li")!.getAttribute("data-ok")).toBe("true");
  });
});
