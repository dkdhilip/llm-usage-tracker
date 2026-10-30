import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const rows = (n: number) => Array.from({ length: n }, (_, i) => row({ id: i + 1, request_id: `req-${i + 1}`, key_label: `key-${i + 1}`, model: `model-${i + 1}` }));
const rowOf = (label: string) => within(screen.getByRole("table")).getByText(label).closest("tr")!;
const inspector = () => screen.findByRole("complementary", { name: "Request inspector" });

describe("Requests: the inspector beside the list", () => {
  it("rows are focusable and open the inspector with Enter or Space, marking the selected row", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(2)));
    const user = userEvent.setup();
    page();
    const first = (await screen.findByText("key-1")).closest("tr")!;
    expect(first).toHaveAttribute("tabindex", "0");
    expect(first).not.toHaveAttribute("aria-current");
    first.focus();
    await user.keyboard("{Enter}");
    await inspector();
    expect(first).toHaveAttribute("aria-current", "true");
    expect(rowOf("key-2")).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    rowOf("key-2").focus();
    await user.keyboard(" ");
    expect(await inspector()).toBeInTheDocument();
    expect(rowOf("key-2")).toHaveAttribute("aria-current", "true");
  });

  it("moves focus into the inspector on open and back to the row on Close or Escape", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(1)));
    const user = userEvent.setup();
    page();
    const r = (await screen.findByText("key-1")).closest("tr")!;
    await user.click(r);
    const box = await inspector();
    await waitFor(() => expect(within(box).getByRole("heading", { name: "Request inspector" })).toHaveFocus());
    await user.click(within(box).getByRole("button", { name: "Close inspector" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Request inspector" })).toBeNull());
    await waitFor(() => expect(r).toHaveFocus());
    await user.click(r);
    await inspector();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Request inspector" })).toBeNull());
    await waitFor(() => expect(r).toHaveFocus());
  });

  it("steps with the Previous and Next buttons, which stay focusable but inactive at the ends", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(3)));
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("key-1")).closest("tr")!);
    const box = await inspector();
    const prev = within(box).getByRole("button", { name: "Previous request" });
    const next = within(box).getByRole("button", { name: "Next request" });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    await user.click(prev);
    expect(rowOf("key-1")).toHaveAttribute("aria-current", "true"); // nothing before the first
    await user.click(next);
    expect(rowOf("key-2")).toHaveAttribute("aria-current", "true");
    await user.click(next);
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(rowOf("key-3")).toHaveAttribute("aria-current", "true");
    await user.click(prev);
    expect(rowOf("key-2")).toHaveAttribute("aria-current", "true");
  });

  it("steps with J and K while focus is in the list, but not while typing in a field", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(3)));
    const user = userEvent.setup();
    page();
    const first = (await screen.findByText("key-1")).closest("tr")!;
    await user.click(first);
    await inspector();
    first.focus();
    await user.keyboard("j");
    expect(rowOf("key-2")).toHaveAttribute("aria-current", "true");
    await user.keyboard("k");
    expect(rowOf("key-1")).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByLabelText("From"));
    await user.keyboard("j");
    expect(rowOf("key-1")).toHaveAttribute("aria-current", "true"); // typed in a field: no shortcut
  });

  it("loads the next page when Next is pressed on the last loaded request, then opens its first row", async () => {
    vi.mocked(api.listRequests)
      .mockResolvedValueOnce({ ...list(rows(2)), next_cursor: 2 })
      .mockResolvedValueOnce(list([row({ id: 3, key_label: "key-3", model: "model-3" })]));
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("key-2")).closest("tr")!);
    await user.click(within(await inspector()).getByRole("button", { name: "Next request" }));
    await waitFor(() => expect(rowOf("key-3")).toHaveAttribute("aria-current", "true"));
    expect(api.listRequests).toHaveBeenLastCalledWith(expect.stringContaining("cursor=2"));
  });

  it("shows status and cost in words: Success, Error, No price yet, Free", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(
      list([row({ id: 1, key_label: "a", status: "error" }), row({ id: 2, key_label: "b", cost: null, cost_source: "unknown" }), row({ id: 3, key_label: "c", cost: 0 })]),
    );
    page();
    await screen.findByText("a");
    expect(within(rowOf("a")).getByText("Error")).toBeInTheDocument();
    expect(within(rowOf("b")).getByText("No price yet")).toBeInTheDocument();
    expect(within(rowOf("b")).queryByText("Free")).toBeNull();
    expect(within(rowOf("c")).getByText("Free")).toBeInTheDocument();
    expect(within(rowOf("c")).getByText("Success")).toBeInTheDocument();
  });

  it("marks requests that have stored content", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row({ id: 1, has_content: true })]));
    page();
    expect(await screen.findByText("Content")).toBeInTheDocument();
  });

  it("opens the request named in the URL, and drops a link to one that is not in the list", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(3)));
    const { unmount } = page("/requests?r=2");
    expect(await inspector()).toBeInTheDocument();
    expect(rowOf("key-2")).toHaveAttribute("aria-current", "true");
    unmount();
    page("/requests?r=99");
    await screen.findByText("key-1");
    expect(screen.queryByRole("complementary", { name: "Request inspector" })).toBeNull();
  });

  it("does not reload the list when a request is opened or stepped", async () => {
    vi.mocked(api.listRequests).mockClear();
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(3)));
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("key-1")).closest("tr")!);
    await inspector();
    await user.click(screen.getByRole("button", { name: "Next request" }));
    expect(api.listRequests).toHaveBeenCalledTimes(1);
  });

  it("hides the Tokens column while the inspector is open", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(1)));
    const user = userEvent.setup();
    page();
    await screen.findByText("key-1");
    expect(screen.getByRole("columnheader", { name: "Tokens" })).toBeInTheDocument();
    await user.click(rowOf("key-1"));
    await inspector();
    expect(screen.queryByRole("columnheader", { name: "Tokens" })).toBeNull();
  });
});

describe("Requests: copy", () => {
  const stored = {
    usage_id: 1, retention_days: 30, content_status: "available" as const, kind: "chat", images: [],
    expires_at: "2026-11-29T10:00:00Z",
    content: { v: 1, kind: "chat", request: { system: "be terse", messages: [{ role: "user", text: "hello gateway" }] }, response: { text: "hi there", summary: "" } },
  };

  it("copies the prompt, the response and the request ID, and says it did", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row({ has_content: true })]));
    vi.mocked(api.requestContent).mockResolvedValue(stored);
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("team-key")).closest("tr")!);
    const box = await inspector();
    await user.click(await within(box).findByRole("button", { name: "Copy prompt" }));
    expect(await navigator.clipboard.readText()).toBe("system: be terse\n\nuser: hello gateway");
    expect(within(box).getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.click(within(box).getByRole("button", { name: "Copy response" }));
    expect(await navigator.clipboard.readText()).toBe("hi there");
    await user.click(within(box).getByRole("button", { name: "Copy ID" }));
    expect(await navigator.clipboard.readText()).toBe("req-1");
  });

  it("states when the stored content will be deleted", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row({ has_content: true })]));
    vi.mocked(api.requestContent).mockResolvedValue(stored);
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("team-key")).closest("tr")!);
    expect(await screen.findByText(/Stored content is encrypted and will be deleted on/)).toBeInTheDocument();
  });

  it("says so when the browser will not let it copy", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list([row()]));
    const user = userEvent.setup();
    page();
    await user.click((await screen.findByText("team-key")).closest("tr")!);
    const box = await inspector();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(within(box).getByRole("button", { name: "Copy ID" }));
    expect(within(box).getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });
});

describe("Requests: full-screen detail on a narrower screen", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists cards, opens a full-screen detail with a Back button, and returns to the card", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(2)));
    const user = userEvent.setup();
    page();
    expect(screen.queryByRole("table")).toBeNull();
    const card = (await screen.findByText("model-1")).closest("button")!;
    await user.click(card);
    expect(await screen.findByRole("heading", { level: 1, name: "Request" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Requests" })).toBeNull(); // the list gives way to the detail
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull(); // sections sit directly under the h1
    await user.click(screen.getByRole("button", { name: "Back to requests list" }));
    await screen.findByRole("list", { name: "Requests" });
    await waitFor(() => expect(screen.getByText("model-1").closest("button")).toHaveFocus());
  });

  it("steps to the next request from the detail", async () => {
    vi.mocked(api.listRequests).mockResolvedValue(list(rows(2)));
    const user = userEvent.setup();
    page("/requests?r=1");
    await screen.findByRole("heading", { level: 1, name: "Request" });
    await user.click(screen.getByRole("button", { name: "Next request" }));
    expect(within(screen.getByRole("region", { name: "Request details" })).getByText(/key-2/)).toBeInTheDocument();
  });
});
