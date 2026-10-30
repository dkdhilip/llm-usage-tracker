import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Requests } from "./Requests";
import { api, type RequestRow } from "../lib/api";

vi.mock("../lib/auth", () => ({ useAuth: () => ({ isWorkspaceAdmin: true }) }));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      models: vi.fn(),
      listKeys: vi.fn(),
      listRequests: vi.fn(),
      requestContent: vi.fn(),
      requestImageUrl: (u: number, i: number) => `/api/requests/${u}/images/${i}`,
    },
  };
});

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 1, ts: "2026-10-20T10:00:00Z", request_id: "req-1", key_id: 1, key_label: "team-key", key_prefix: "vk_abcdefgh",
  provider: "openai", model: "gpt-4o-mini", prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.001,
  cost_source: "configured", latency_ms: 10, status: "success", prompt_preview: null, response_preview: null,
  has_content: false, ...over,
});
const list = (items: RequestRow[]) => ({ items, next_cursor: null, bodies_logged: false, content_logging_enabled: false });
const page = (url = "/requests") => render(<MemoryRouter initialEntries={[url]}><Requests /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(api.models).mockResolvedValue([]);
  vi.mocked(api.listKeys).mockResolvedValue([]);
});

describe("Requests: honest loading, error and empty states", () => {
  it("shows a placeholder, not 'No requests yet', while the list is loading", async () => {
    vi.mocked(api.listRequests).mockReturnValue(new Promise(() => {}));
    page();
    await waitFor(() => expect(api.listRequests).toHaveBeenCalled());
    expect(screen.queryByText(/No requests yet/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces a failed load with a Retry that reloads, and does not claim there are no requests", async () => {
    vi.mocked(api.listRequests).mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(list([row()]));
    const user = userEvent.setup();
    page();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load requests");
    expect(alert).toHaveTextContent("database unavailable");
    expect(screen.queryByText(/No requests yet/)).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("team-key")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says what to do when there really are no requests, and says so differently when filters hide them", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([]));
    const { unmount } = page();
    expect(await screen.findByText(/Point your app at the gateway/)).toBeInTheDocument();
    unmount();
    page("/requests?provider=openai");
    expect(await screen.findByText("No requests match these filters.")).toBeInTheDocument();
  });
});

describe("Requests: keyboard and dialog behaviour", () => {
  it("rows are focusable and open the detail with Enter or Space", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row()]));
    const user = userEvent.setup();
    page();
    const r = (await screen.findByText("team-key")).closest("tr")!;
    expect(r).toHaveAttribute("tabindex", "0");
    r.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Request detail" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    r.focus();
    await user.keyboard(" ");
    expect(await screen.findByRole("dialog", { name: "Request detail" })).toBeInTheDocument();
  });

  it("the detail is a labelled dialog with a named Close, Escape closes it, and focus returns to the row", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row()]));
    const user = userEvent.setup();
    page();
    const r = (await screen.findByText("team-key")).closest("tr")!;
    await user.click(r);
    const dialog = await screen.findByRole("dialog", { name: "Request detail" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(dialog).getByText("req-1")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(r).toHaveFocus());
  });

  it("traps Tab inside the open detail", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row()]));
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("team-key")).closest("tr")!);
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
