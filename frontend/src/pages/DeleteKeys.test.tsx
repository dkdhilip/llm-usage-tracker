import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const revokedBox = () => screen.getByRole("checkbox", { name: "Revoked" });
const deletedBox = () => screen.getByRole("checkbox", { name: "Deleted" });

describe("Workspace -> red confirmation before revoke / delete", () => {
  it("revoke asks first in a red box naming the key, and does nothing on Cancel", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("active-one");
    await chooseKeyAction(user, "active-one", "Revoke key");
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
    await screen.findByText("active-one");
    await chooseKeyAction(user, "active-one", "Revoke key");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.revokeKey).not.toHaveBeenCalled();
  });

  it("confirming revoke calls the API once, closes the box and reloads the keys", async () => {
    const user = userEvent.setup();
    vi.mocked(api.revokeKey).mockResolvedValue({ id: 1, revoked_at: WHEN });
    page();
    await screen.findByText("active-one");
    await chooseKeyAction(user, "active-one", "Revoke key");
    const calls = vi.mocked(api.listKeys).mock.calls.length;
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke key" }));
    expect(api.revokeKey).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(vi.mocked(api.listKeys).mock.calls.length).toBeGreaterThan(calls);
  });

  it("only revoked keys offer Delete, and it asks in a red box that says the history is kept", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("checkbox", { name: "Revoked" }));
    await screen.findByText("old-a");
    await user.click(within(keyRow("active-one")).getByRole("button", { name: "More actions for active-one" }));
    expect(screen.queryByRole("menuitem", { name: "Delete key" })).toBeNull(); // not on the active key
    await user.keyboard("{Escape}");
    await chooseKeyAction(user, "old-a", "Delete key");
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
    await user.click(await screen.findByRole("checkbox", { name: "Revoked" }));
    await screen.findByText("old-a");
    await chooseKeyAction(user, "old-a", "Delete key");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete key" }));
    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent("nope");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete key" }));
    expect(api.deleteKey).toHaveBeenLastCalledWith(3);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("Workspace -> deleted keys", () => {
  it("keeps deleted keys out of the list until Deleted is ticked, then shows them without actions", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("active-one");
    expect(screen.getByText("1 active · 1 revoked · 1 deleted")).toBeTruthy();
    expect(screen.queryByText("gone-a")).toBeNull();
    expect(deletedBox()).not.toBeChecked();
    await user.click(deletedBox());
    await screen.findByText("gone-a");
    const row = keyRow("gone-a");
    expect(within(row).getByText("Deleted")).toBeTruthy();
    expect(within(row).getByText("12")).toBeTruthy(); // its history is still shown
    expect(within(row).queryByRole("button")).toBeNull(); // nothing can be done to a deleted key
    expect(screen.getByText(/can no longer be used or changed/)).toBeTruthy();
    // even with revoked keys shown, a deleted key is listed once
    await user.click(revokedBox());
    expect(screen.getAllByText("gone-a")).toHaveLength(1);
    await user.click(deletedBox());
    expect(screen.queryByText("gone-a")).toBeNull();
  });

  it("does not mention deleted keys when nothing is deleted", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 1, label: "only" })]);
    page();
    await screen.findByText("only");
    expect(screen.queryByText(/deleted/)).toBeNull();
  });
});
