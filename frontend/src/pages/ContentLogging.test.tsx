import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      setImageLogging: vi.fn(),
      requestImageUrl: (u: number, i: number) => `/api/requests/${u}/images/${i}`,
    },
  };
});

const workspace = (enabled: boolean, images = false, used = 0) => ({
  id: 1, name: "Acme", role: "admin" as const, members: [], invites: [], providers: [],
  content_logging: { enabled, retention_days: 30, updated_at: enabled ? "2026-10-20T10:00:00Z" : null },
  image_logging: {
    enabled: images, updated_at: null, used_bytes: used, cap_bytes: 50_000_000, max_image_bytes: 2_000_000,
    max_per_request: 4, global_full: false,
  },
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
    render(<MemoryRouter initialEntries={["/workspace?tab=settings"]}><Workspace /></MemoryRouter>);
    await screen.findByText("Prompt & response logging");
    expect(screen.getByText("Off")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    let box = await screen.findByRole("alertdialog");
    expect(within(box).getByText(/30 days/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.setContentLogging).not.toHaveBeenCalled(); // declined: nothing changed

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    box = await screen.findByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(api.setContentLogging).toHaveBeenCalledWith(true));
  });

  it("turns off without a prompt and deletes stored content only after confirming", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace(true));
    vi.mocked(api.setContentLogging).mockResolvedValue(workspace(false));
    vi.mocked(api.deleteStoredContent).mockResolvedValue({ deleted: 3 });
    render(<MemoryRouter initialEntries={["/workspace?tab=settings"]}><Workspace /></MemoryRouter>);
    await screen.findByText("On");

    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setContentLogging).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("alertdialog")).toBeNull(); // turning off asks nothing

    await user.click(screen.getByRole("button", { name: "Delete stored content" }));
    let box = await screen.findByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(api.deleteStoredContent).not.toHaveBeenCalled(); // declined
    await user.click(screen.getByRole("button", { name: "Delete stored content" }));
    box = await screen.findByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "Delete" }));
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
    await screen.findByText("Request inspector");
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

describe("Workspace -> image storage", () => {
  it("is off by default, needs its own confirmation, and shows storage use against the cap", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace(true, false, 12_500_000));
    vi.mocked(api.setImageLogging).mockResolvedValue(workspace(true, true, 12_500_000));
    render(<MemoryRouter initialEntries={["/workspace?tab=settings"]}><Workspace /></MemoryRouter>);
    await screen.findByText("Images off");
    expect(screen.getByTestId("image-logging").textContent).toContain("12.5 MB of 50 MB");
    const bar = screen.getByRole("progressbar", { name: "Image storage used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuetext")).toMatch(/of/);

    await user.click(screen.getByRole("button", { name: "Turn on images" }));
    let box = await screen.findByRole("alertdialog");
    expect(within(box).getByText(/faces and personal data/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(api.setImageLogging).not.toHaveBeenCalled(); // declined

    await user.click(screen.getByRole("button", { name: "Turn on images" }));
    box = await screen.findByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(api.setImageLogging).toHaveBeenCalledWith(true));
    expect(api.setContentLogging).not.toHaveBeenCalled(); // the two switches are independent
  });

  it("warns when the workspace limit is reached and when text logging is off", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace(false, true, 50_000_000));
    render(<MemoryRouter initialEntries={["/workspace?tab=settings"]}><Workspace /></MemoryRouter>);
    await screen.findByText("Images on");
    expect(screen.getByText(/image limit for this workspace is reached/)).toBeTruthy();
    expect(screen.getByText(/text logging is currently off/)).toBeTruthy();
  });
});

describe("Requests -> images", () => {
  const withImages = async (content: RequestContent) => {
    vi.mocked(api.listRequests).mockResolvedValue({
      items: [row(21, true)], next_cursor: null, bodies_logged: false, content_logging_enabled: true,
    });
    vi.mocked(api.requestContent).mockResolvedValue(content);
    const user = userEvent.setup();
    render(<MemoryRouter><Requests /></MemoryRouter>);
    await user.click(await screen.findByText("team-key"));
  };
  const base: RequestContent = {
    usage_id: 21, retention_days: 30, content_status: "available", kind: "chat",
    content: { v: 1, kind: "chat", request: { messages: [{ role: "user", text: "what is this" }] }, response: { text: "a cat", summary: "" },
               images_skipped: [{ role: "input", reason: "url_not_stored" }] },
    images: [
      { id: 5, role: "input", position: 0, mime: "image/png", bytes: 2048 },
      { id: 6, role: "output", position: 0, mime: "image/webp", bytes: 4096 },
    ],
  };

  it("renders real images from the image endpoint (never inline data) and explains skipped ones", async () => {
    await withImages(base);
    const sent = await screen.findByAltText("input image 1");
    expect(sent.getAttribute("src")).toBe("/api/requests/21/images/5");
    expect(screen.getByAltText("output image 1").getAttribute("src")).toBe("/api/requests/21/images/6");
    expect(screen.getByText("Images sent")).toBeTruthy();
    expect(screen.getByText("Images generated")).toBeTruthy();
    expect(screen.getByText(/links are never downloaded or stored/)).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/base64|data:image/);
  });

  it("falls back to a message when an image fails to load (expired or unreadable)", async () => {
    await withImages(base);
    fireEvent.error(await screen.findByAltText("input image 1"));
    expect(await screen.findByText(/Image unavailable/)).toBeTruthy();
    expect(screen.getByAltText("output image 1")).toBeTruthy(); // the other image is unaffected
  });

  it("shows no image section for a text-only record", async () => {
    await withImages({ ...base, images: [], content: { ...base.content!, images_skipped: undefined } });
    await screen.findByText("what is this");
    expect(screen.queryByText("Images sent")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
