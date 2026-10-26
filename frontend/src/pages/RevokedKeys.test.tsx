import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { api, type KeyRow } from "../lib/api";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isWorkspaceAdmin: true, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: { getWorkspace: vi.fn(), listKeys: vi.fn(), listModelPricing: vi.fn(), getAccount: vi.fn(), integrationGuide: vi.fn() },
  };
});

const key = (over: Partial<KeyRow>): KeyRow => ({
  id: 1, label: "team-key", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai"],
  allow_live: true, default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null,
  budget_end: null, expires_at: null, spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null,
  requests: 0, total_tokens: 0, cost: 0, ...over,
});
const REVOKED = "2026-09-01T00:00:00Z";

function page() {
  return render(<MemoryRouter><Workspace /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getWorkspace).mockResolvedValue({ id: 1, name: "Acme", role: "admin", members: [], invites: [], providers: [] });
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.listKeys).mockResolvedValue([
    key({ id: 1, label: "active-one" }),
    key({ id: 2, label: "active-two" }),
    key({ id: 3, label: "old-a", revoked_at: REVOKED }),
    key({ id: 4, label: "old-b", revoked_at: REVOKED }),
  ]);
});

describe("Workspace -> revoked keys", () => {
  it("hides revoked keys by default, counts only the active ones, and says how many are tucked away", async () => {
    page();
    await screen.findByText("active-one");
    expect(screen.getByText("active-two")).toBeTruthy();
    expect(screen.queryByText("old-a")).toBeNull();
    expect(screen.queryByText("old-b")).toBeNull();
    expect(screen.getByText("Virtual keys (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show revoked keys (2)" })).toBeTruthy();
  });

  it("shows them on request, marked revoked, and hides them again", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Show revoked keys (2)" }));
    expect(await screen.findByText("old-a")).toBeTruthy();
    expect(screen.getByText("old-b")).toBeTruthy();
    expect(screen.getAllByText("revoked")).toHaveLength(2);
    expect(screen.getByText("Virtual keys (2)")).toBeTruthy(); // the title still counts active keys
    await user.click(screen.getByRole("button", { name: "Hide revoked keys (2)" }));
    expect(screen.queryByText("old-a")).toBeNull();
  });

  it("remembers the choice in this browser", async () => {
    const user = userEvent.setup();
    const { unmount } = page();
    await user.click(await screen.findByRole("button", { name: "Show revoked keys (2)" }));
    unmount();
    page();
    expect(await screen.findByText("old-a")).toBeTruthy(); // still shown after a reload
    expect(screen.getByRole("button", { name: "Hide revoked keys (2)" })).toBeTruthy();
  });

  it("has no toggle when nothing is revoked", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "only" })]);
    page();
    await screen.findByText("only");
    expect(screen.queryByRole("button", { name: /revoked keys/ })).toBeNull();
  });

  it("explains an empty list when every key is revoked", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 3, label: "old-a", revoked_at: REVOKED })]);
    page();
    expect(await screen.findByText(/No active keys/)).toBeTruthy();
    expect(screen.getByText("Virtual keys (0)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show revoked keys (1)" })).toBeTruthy();
  });

  it("still shows the usual empty message when there are no keys at all", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([]);
    page();
    expect(await screen.findByText("No keys yet — create one above.")).toBeTruthy();
  });
});
