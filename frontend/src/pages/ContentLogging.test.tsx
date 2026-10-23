import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Requests } from "./Requests";
import { Workspace } from "./Workspace";
import { api, type RequestContent, type RequestRow } from "../lib/api";

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
      setContentLogging: vi.fn(),
      deleteStoredContent: vi.fn(),
      models: vi.fn(),
      listRequests: vi.fn(),
      requestContent: vi.fn(),
    },
  };
});

const workspace = (enabled: boolean) => ({
  id: 1, name: "Acme", role: "admin" as const, members: [], invites: [], providers: [],
  content_logging: { enabled, retention_days: 30, updated_at: enabled ? "2026-10-20T10:00:00Z" : null },
});

const row = (id: number, has_content: boolean): RequestRow => ({
  id, ts: "2026-10-20T10:00:00Z", request_id: `req-${id}`, key_id: 1, key_label: "team-key", key_prefix: "vk_abcdefgh",
  provider: "openai", model: "gpt-4o-mini", prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.001,
  cost_source: "configured", latency_ms: 10, status: "success", prompt_preview: null, response_preview: null, has_content,
});

beforeEach(() => {
  vi.mocked(api.getWorkspace).mockResolvedValue(workspace(false));
  vi.mocked(api.listKeys).mockResolvedValue([]);
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.models).mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("Workspace → Prompt & response logging", () => {
  it("shows it off by default, and turning it on needs an explicit confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.setContentLogging).mockResolvedValue(workspace(true));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<MemoryRouter><Workspace /></MemoryRouter>);
    await screen.findByText("Prompt & response logging");
    expect(screen.getByText("Off")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/30 days/);
    expect(api.setContentLogging).not.toHaveBeenCalled(); // declined: nothing changed

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(api.setContentLogging).toHaveBeenCalledWith(true));
  });

  it("turns off without a prompt and deletes stored content only after confirming", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace(true));
    vi.mocked(api.setContentLogging).mockResolvedValue(workspace(false));
    vi.mocked(api.deleteStoredContent).mockResolvedValue({ deleted: 3 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<MemoryRouter><Workspace /></MemoryRouter>);
    await screen.findByText("On");

    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setContentLogging).toHaveBeenCalledWith(false));
    expect(confirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete stored content" }));
    expect(api.deleteStoredContent).not.toHaveBeenCalled(); // declined
    await user.click(screen.getByRole("button", { name: "Delete stored content" }));
    await screen.findByText("Deleted 3 stored records.");
  });
});

describe("Requests → stored content", () => {
  const open = async (rows: RequestRow[], content?: RequestContent | Error) => {
    vi.mocked(api.listRequests).mockResolvedValue({
      items: rows, next_cursor: null, bodies_logged: false, content_logging_enabled: true,
    });
    if (content instanceof Error) vi.mocked(api.requestContent).mockRejectedValue(content);
    else if (content) vi.mocked(api.requestContent).mockResolvedValue(content);
    const user = userEvent.setup();
    render(<MemoryRouter><Requests /></MemoryRouter>);
    await user.click(await screen.findByText("team-key"));
  };

  it("fetches and shows messages, response and truncation only when the row has content", async () => {
    await open([row(7, true)], {
      usage_id: 7, retention_days: 30, content_status: "available", kind: "chat",
      expires_at: "2026-11-19T10:00:00Z", request_truncated: false, response_truncated: true,
      content: {
        v: 1, kind: "chat",
        request: { messages: [{ role: "system", text: "be terse" }, { role: "user", text: "hello gateway" }] },
        response: { text: "hi there", summary: "" },
      },
    });
    await screen.findByText("hello gateway");
    expect(screen.getByText("be terse")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(screen.getByText(/response exceeded the storage limit/)).toBeTruthy();
    expect(api.requestContent).toHaveBeenCalledWith(7);
  });

  it("does not request content for a row without any", async () => {
    await open([row(8, false)]);
    await screen.findByText("Request detail");
    expect(api.requestContent).not.toHaveBeenCalled();
  });

  it("explains expired and unreadable content and surfaces fetch errors", async () => {
    await open([row(9, true)], { usage_id: 9, retention_days: 30, content_status: "expired", content: null });
    await screen.findByText(/Stored content expired/);
  });

  it("shows the error when the content cannot be loaded", async () => {
    await open([row(10, true)], new Error("forbidden"));
    await screen.findByText("forbidden");
  });
});
