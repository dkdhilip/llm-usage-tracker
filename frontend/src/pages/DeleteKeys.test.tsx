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
    api: {
      getWorkspace: vi.fn(), listKeys: vi.fn(), listModelPricing: vi.fn(), getAccount: vi.fn(), integrationGuide: vi.fn(),
      revokeKey: vi.fn(), deleteKey: vi.fn(),
    },
  };
});

const key = (over: Partial<KeyRow>): KeyRow => ({
  id: 1, label: "team-key", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai"],
  allow_live: true, default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null,
  budget_end: null, expires_at: null, spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null,
  requests: 0, total_tokens: 0, cost: 0, ...over,
});
const WHEN = "2026-09-01T00:00:00Z";

function page() {
  return render(<MemoryRouter><Workspace /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.getWorkspace).mockResolvedValue({ id: 1, name: "Acme", role: "admin", members: [], invites: [], providers: [] });
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.listKeys).mockResolvedValue([
    key({ id: 1, label: "active-one" }),
    key({ id: 3, label: "old-a", revoked_at: WHEN }),
    key({ id: 5, label: "gone-a", revoked_at: WHEN, deleted_at: WHEN, requests: 12, cost: 1.5 }),
  ]);
});

describe("Workspace -> red confirmation before revoke / delete", () => {
  it("revoke asks first in a red box naming the key, and does nothing on Cancel", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("active-one");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const box = screen.getByRole("alertdialog");
    expect(within(box).getByText("Revoke this key?")).toBeTruthy();
    expect(within(box).getByText("active-one")).toBeTruthy();
    expect(box.className).toMatch(/border-danger-line/); // the red (danger) dialog
    expect(api.revokeKey).not.toHaveBeenCalled();
    await user.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.revokeKey).not.toHaveBeenCalled();
  });

  it("Escape also cancels", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.revokeKey).not.toHaveBeenCalled();
  });

  it("confirming revoke calls the API once, closes the box and reloads the keys", async () => {
    const user = userEvent.setup();
    vi.mocked(api.revokeKey).mockResolvedValue({ id: 1, revoked_at: WHEN });
    page();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    const calls = vi.mocked(api.listKeys).mock.calls.length;
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke key" }));
    expect(api.revokeKey).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(vi.mocked(api.listKeys).mock.calls.length).toBeGreaterThan(calls);
  });

  it("only revoked keys offer Delete, and it asks in a red box that says the history is kept", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Show revoked keys (1)" }));
    await screen.findByText("old-a");
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1); // not on the active key
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const box = screen.getByRole("alertdialog");
    expect(within(box).getByText("Delete this key?")).toBeTruthy();
    expect(within(box).getByText("old-a")).toBeTruthy();
    expect(box.textContent).toMatch(/usage history/);
    expect(api.deleteKey).not.toHaveBeenCalled();
  });

  it("confirming delete calls the API, and a failure is shown inside the box and keeps it open", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteKey).mockRejectedValueOnce(new Error("nope")).mockResolvedValue({ id: 3, revoked_at: WHEN, deleted_at: WHEN });
    page();
    await user.click(await screen.findByRole("button", { name: "Show revoked keys (1)" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete key" }));
    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent("nope");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete key" }));
    expect(api.deleteKey).toHaveBeenLastCalledWith(3);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("Workspace -> Deleted keys section", () => {
  it("keeps deleted keys out of the main table and its counts, and lists them separately on request", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("active-one");
    expect(screen.getByText("Virtual keys (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show revoked keys (1)" })).toBeTruthy(); // the deleted one is not counted
    expect(screen.queryByText("gone-a")).toBeNull();
    expect(screen.getByText("Deleted keys (1)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show deleted keys" }));
    expect(await screen.findByText("gone-a")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy(); // its history is still shown
    expect(screen.getByText(/can no longer be used or changed/)).toBeTruthy();
    // even with revoked keys shown, a deleted key never returns to the main table
    await user.click(screen.getByRole("button", { name: "Show revoked keys (1)" }));
    expect(screen.getAllByText("gone-a")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Hide deleted keys" }));
    expect(screen.queryByText("gone-a")).toBeNull();
  });

  it("has no Deleted keys section when nothing is deleted", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "only" })]);
    page();
    await screen.findByText("only");
    expect(screen.queryByText(/Deleted keys/)).toBeNull();
  });
});
