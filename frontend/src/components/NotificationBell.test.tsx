import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";
import { api, type GuardrailHitGroup } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: { guardrails: { unreadCount: vi.fn(), hitGroups: vi.fn(), reviewHits: vi.fn() } } };
});

const g = vi.mocked(api.guardrails);

const group = (over: Partial<GuardrailHitGroup> = {}): GuardrailHitGroup => ({
  key_id: 1, key_label: "support-bot", key_prefix: "vk_abc", rule_id: 5, rule_name: "Card numbers", rule_set_name: "No secrets", rule_kind: "preset",
  action: "block", total: 3, unread: 2, last_seen: new Date().toISOString(), last_hit_id: 30, ...over,
});

const bell = () =>
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  g.unreadCount.mockResolvedValue({ count: 0, latest_hit_id: 0 });
  g.hitGroups.mockResolvedValue({ items: [], unread_total: 0 });
  g.reviewHits.mockResolvedValue({ reviewed: 1 });
});
afterEach(() => vi.useRealTimers());

describe("the notification bell", () => {
  it("says there is nothing unread, in words", async () => {
    bell();
    expect(await screen.findByRole("button", { name: "Notifications, none unread" })).toBeInTheDocument();
    expect(screen.queryByTestId("bell-count")).not.toBeInTheDocument();
  });

  it("puts the unread number in its accessible name, and caps it at 99+", async () => {
    g.unreadCount.mockResolvedValue({ count: 7, latest_hit_id: 9 });
    const { unmount } = bell();
    expect(await screen.findByRole("button", { name: "Notifications, 7 unread" })).toBeInTheDocument();
    expect(screen.getByTestId("bell-count")).toHaveTextContent("7");
    unmount();
    g.unreadCount.mockResolvedValue({ count: 250, latest_hit_id: 9 });
    bell();
    expect(await screen.findByRole("button", { name: "Notifications, 99+ unread" })).toBeInTheDocument();
  });

  it("announces new matches once, politely", async () => {
    g.unreadCount.mockResolvedValue({ count: 2, latest_hit_id: 2 });
    bell();
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    expect(screen.getByText("2 unread content rule matches")).toBeInTheDocument();
  });

  it("keeps the last number when a refresh fails", async () => {
    g.unreadCount.mockResolvedValueOnce({ count: 4, latest_hit_id: 4 });
    bell();
    await screen.findByRole("button", { name: "Notifications, 4 unread" });
    g.unreadCount.mockRejectedValue(new Error("offline"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("button", { name: "Notifications, 4 unread" })).toBeInTheDocument();
  });

  it("refreshes when the window regains focus and every minute while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bell();
    await waitFor(() => expect(g.unreadCount).toHaveBeenCalledTimes(1));
    g.unreadCount.mockResolvedValue({ count: 3, latest_hit_id: 3 });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument());
    g.unreadCount.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(g.unreadCount).toHaveBeenCalled();
  });

  it("lists matches by key and rule, with action and counts as text, and links to the requests", async () => {
    const user = userEvent.setup();
    g.unreadCount.mockResolvedValue({ count: 2, latest_hit_id: 30 });
    g.hitGroups.mockResolvedValue({ items: [group(), group({ rule_id: 6, rule_name: "Codename", action: "flag", unread: 0, total: 1, last_hit_id: 12 })], unread_total: 2 });
    bell();
    await user.click(await screen.findByRole("button", { name: /Notifications, 2 unread/ }));
    const list = await screen.findByRole("list", { name: "Matches by key and rule" });
    const first = within(list).getAllByRole("listitem")[0];
    expect(within(first).getByText("Blocked")).toBeInTheDocument();
    expect(within(first).getByText(/2 unread · 3 total/)).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: /Card numbers on support-bot: view requests/ })).toHaveAttribute("href", "/requests?key_id=1&guardrail=blocked");
    const second = within(list).getAllByRole("listitem")[1];
    expect(within(second).getByText("Flagged")).toBeInTheDocument();
    expect(within(second).getByText(/reviewed · 1 total/)).toBeInTheDocument();
    expect(within(second).queryByRole("button", { name: /Mark reviewed/ })).not.toBeInTheDocument();
  });

  it("marks everything on screen reviewed, only up to the newest match it showed", async () => {
    const user = userEvent.setup();
    g.unreadCount.mockResolvedValue({ count: 2, latest_hit_id: 99 }); // something newer arrived that the list has not shown
    g.hitGroups.mockResolvedValueOnce({ items: [group({ last_hit_id: 30 }), group({ rule_id: 6, rule_name: "Codename", last_hit_id: 41 })], unread_total: 2 });
    g.hitGroups.mockResolvedValue({ items: [], unread_total: 0 });
    bell();
    await user.click(await screen.findByRole("button", { name: /Notifications, 2 unread/ }));
    await user.click(await screen.findByRole("button", { name: "Mark all reviewed" }));
    await waitFor(() => expect(g.reviewHits).toHaveBeenCalledWith({ up_to_id: 41 }));
    expect(await screen.findByRole("button", { name: "Notifications, none unread" })).toBeInTheDocument();
  });

  it("marks one group reviewed", async () => {
    const user = userEvent.setup();
    g.unreadCount.mockResolvedValue({ count: 2, latest_hit_id: 30 });
    g.hitGroups.mockResolvedValue({ items: [group()], unread_total: 2 });
    bell();
    await user.click(await screen.findByRole("button", { name: /Notifications, 2 unread/ }));
    await user.click(await screen.findByRole("button", { name: /Mark reviewed Card numbers on support-bot/ }));
    await waitFor(() => expect(g.reviewHits).toHaveBeenCalledWith({ up_to_id: 30, key_id: 1, rule_id: 5, action: "block" }));
  });

  it("says when there is nothing, and when everything is reviewed", async () => {
    const user = userEvent.setup();
    bell();
    await user.click(await screen.findByRole("button", { name: /Notifications/ }));
    expect(await screen.findByText(/No matches yet/)).toBeInTheDocument();
  });

  it("shows a failure to load in words", async () => {
    const user = userEvent.setup();
    g.hitGroups.mockRejectedValue(new Error("database unavailable"));
    bell();
    await user.click(await screen.findByRole("button", { name: /Notifications/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
  });
});
