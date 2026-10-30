import { render, screen, within } from "@testing-library/react";
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

const table = () => within(screen.getByRole("table"));
const revokedBox = () => screen.getByRole("checkbox", { name: "Revoked" });

describe("Workspace -> revoked keys", () => {
  it("hides revoked keys by default and says how many keys there are of each kind", async () => {
    page();
    await screen.findByText("active-one");
    expect(screen.getByText("active-two")).toBeTruthy();
    expect(screen.queryByText("old-a")).toBeNull();
    expect(screen.queryByText("old-b")).toBeNull();
    expect(screen.getByText("2 active · 2 revoked")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
    expect(revokedBox()).not.toBeChecked();
  });

  it("shows them when Revoked is ticked, marked revoked, and hides them again", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("checkbox", { name: "Revoked" }));
    expect(await screen.findByText("old-a")).toBeTruthy();
    expect(screen.getByText("old-b")).toBeTruthy();
    expect(table().getAllByText("Revoked")).toHaveLength(2);
    expect(screen.getByText("2 active · 2 revoked")).toBeTruthy(); // the counts do not change with the filter
    await user.click(revokedBox());
    expect(screen.queryByText("old-a")).toBeNull();
  });

  it("remembers the choice in this browser", async () => {
    const user = userEvent.setup();
    const { unmount } = page();
    await user.click(await screen.findByRole("checkbox", { name: "Revoked" }));
    unmount();
    page();
    expect(await screen.findByText("old-a")).toBeTruthy(); // still shown after a reload
    expect(revokedBox()).toBeChecked();
  });

  it("does not mention revoked keys when nothing is revoked", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "only" })]);
    page();
    await screen.findByText("only");
    expect(screen.getByText("1 active")).toBeTruthy();
  });

  it("explains an empty list when every key is revoked, and where they are", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 3, label: "old-a", revoked_at: REVOKED })]);
    page();
    expect(await screen.findByText(/No keys with these statuses/)).toBeTruthy();
    expect(screen.getByText("0 active · 1 revoked")).toBeTruthy();
  });

  it("still shows the usual empty message when there are no keys at all", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([]);
    page();
    expect(await screen.findByText("No keys yet. Create one to get started.")).toBeTruthy();
  });
});
