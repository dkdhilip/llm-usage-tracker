import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      integrationGuide: vi.fn(),
      createKey: vi.fn(),
      updateKey: vi.fn(),
      revokeKey: vi.fn(),
      setContentLogging: vi.fn(),
      setImageLogging: vi.fn(),
      deleteStoredContent: vi.fn(),
    },
  };
});

const SECRET = "vk_BRAND_NEW_SECRET_VALUE_9876543210";

const workspace = (master: { text: boolean; images: boolean }, keysLogging = 1) => ({
  id: 1, name: "Acme", role: "admin" as const, members: [], invites: [],
  providers: [{ provider: "openai", configured: true, source: "workspace" as const, last4: "0000", monthly_cap_usd: null, spend_this_month: 0 }],
  content_logging: { enabled: master.text, retention_days: 30, updated_at: null, keys_total: 4, keys_logging: keysLogging, keys_logging_images: 1 },
  image_logging: { enabled: master.images, updated_at: null, used_bytes: 0, cap_bytes: 50_000_000, max_image_bytes: 2_000_000, max_per_request: 4, global_full: false },
});

const key = (over: Partial<KeyRow>): KeyRow => ({
  id: 1, label: "team-key", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai"],
  allow_live: true, default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null,
  budget_end: null, expires_at: null, spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null,
  requests: 0, total_tokens: 0, cost: 0, content_logging_enabled: false, image_logging_enabled: false, ...over,
});

function guide(): IntegrationGuideData {
  const mk = (p: "openai" | "anthropic" | "gemini", label: string) => ({
    provider: p, label, sdk: "", install: "", gateway_url: "https://gw.example.com", base_url: "", endpoint: "",
    env_vars: [], env_file: "", code: "", model_example: "", notes: [], requirements: [],
  });
  return {
    target: "hosted", gateway_url: "https://gw.example.com", targets: { hosted: "https://gw.example.com", local: "http://127.0.0.1:8000" },
    general_notes: [], providers: [mk("openai", "OpenAI"), mk("anthropic", "Anthropic"), mk("gemini", "Gemini")],
  };
}

function page() {
  return render(<MemoryRouter><Workspace /></MemoryRouter>);
}

const KEYS = [
  key({ id: 1, label: "off-key" }),
  key({ id: 2, label: "text-key", key_prefix: "vk_text0000", content_logging_enabled: true }),
  key({ id: 3, label: "image-key", key_prefix: "vk_imag0000", content_logging_enabled: true, image_logging_enabled: true }),
  key({ id: 4, label: "stale-image-flag", key_prefix: "vk_stal0000", image_logging_enabled: true }), // image on, text off
];

beforeEach(() => {
  vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ text: true, images: true }));
  vi.mocked(api.listKeys).mockResolvedValue(KEYS);
  vi.mocked(api.listModelPricing).mockResolvedValue([]);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.updateKey).mockResolvedValue({});
  vi.mocked(api.integrationGuide).mockImplementation(async () => guide());
});

afterEach(() => vi.restoreAllMocks());

const rowOf = async (label: string) => (await screen.findByText(label)).closest("tr")!;

describe("Workspace -> per-key logging", () => {
  it("shows each key's logging state, never inventing logging for a key with text off", async () => {
    page();
    expect(within((await rowOf("off-key")).querySelector('[data-testid="key-logging-1"]') as HTMLElement).getByText("Off")).toBeTruthy();
    expect(within((await rowOf("text-key")).querySelector('[data-testid="key-logging-2"]') as HTMLElement).getByText("Text")).toBeTruthy();
    expect(within((await rowOf("image-key")).querySelector('[data-testid="key-logging-3"]') as HTMLElement).getByText("Text + images")).toBeTruthy();
    // an image flag without the text flag is not a logging key
    expect(within((await rowOf("stale-image-flag")).querySelector('[data-testid="key-logging-4"]') as HTMLElement).getByText("Off")).toBeTruthy();
  });

  it("marks keys as inactive when a workspace master switch is off", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ text: false, images: false }));
    page();
    const cell = (await rowOf("image-key")).querySelector('[data-testid="key-logging-3"]') as HTMLElement;
    expect(cell.textContent).toMatch(/Text \+ images \(inactive\)/);
    expect((await rowOf("off-key")).querySelector('[data-testid="key-logging-1"]')!.textContent).toBe("Off"); // off stays plain off
  });

  it("describes the master switch and how many keys are logging", async () => {
    page();
    const summary = await screen.findByTestId("keys-logging-summary");
    expect(summary.textContent).toMatch(/workspace master switch/);
    expect(summary.textContent).toMatch(/1 of 4 keys/);
  });

  it("opens an editor per key; turning text logging on needs a confirmation that names the key", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    page();
    await user.click(within(await rowOf("off-key")).getByRole("button", { name: "Logging" }));
    const editor = await screen.findByTestId("key-logging-editor-1");
    expect(editor.textContent).toContain("off-key (vk_abcdefgh…)"); // label + prefix only, never a secret
    const [textBox, imageBox] = within(editor).getAllByRole("checkbox") as HTMLInputElement[];
    expect(textBox.checked).toBe(false);
    expect(imageBox.disabled).toBe(true); // images need text logging on the same key

    await user.click(textBox);
    expect(confirm.mock.calls[0][0]).toMatch(/off-key \(vk_abcdefgh…\)/);
    expect(api.updateKey).not.toHaveBeenCalled(); // declined
    await user.click(textBox);
    await waitFor(() => expect(api.updateKey).toHaveBeenCalledWith(1, { content_logging_enabled: true }));
  });

  it("turning text off also turns images off and needs no confirmation; images have their own confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    page();
    await user.click(within(await rowOf("image-key")).getByRole("button", { name: "Logging" }));
    const editor = await screen.findByTestId("key-logging-editor-3");
    const [textBox] = within(editor).getAllByRole("checkbox") as HTMLInputElement[];
    await user.click(textBox);
    await waitFor(() =>
      expect(api.updateKey).toHaveBeenCalledWith(3, { content_logging_enabled: false, image_logging_enabled: false }),
    );
    expect(confirm).not.toHaveBeenCalled();

    await user.click(within(await rowOf("text-key")).getByRole("button", { name: "Logging" }));
    const ed2 = await screen.findByTestId("key-logging-editor-2");
    const imageBox = within(ed2).getAllByRole("checkbox")[1] as HTMLInputElement;
    expect(imageBox.disabled).toBe(false);
    await user.click(imageBox);
    expect(confirm.mock.calls[0][0]).toMatch(/faces and personal data/);
    await waitFor(() => expect(api.updateKey).toHaveBeenCalledWith(2, { image_logging_enabled: true }));
  });

  it("warns inside the editor when a master switch is off, and explains that turning off stops new capture only", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ text: false, images: false }));
    const user = userEvent.setup();
    page();
    await user.click(within(await rowOf("text-key")).getByRole("button", { name: "Logging" }));
    const editor = await screen.findByTestId("key-logging-editor-2");
    expect(editor.textContent).toMatch(/Prompt & response logging is off, so nothing is logged for this key yet/);
    expect(editor.textContent).toMatch(/stops new capture only/);
  });

  it("surfaces an update error and leaves the editor usable", async () => {
    vi.mocked(api.updateKey).mockRejectedValue(new Error("forbidden"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    page();
    await user.click(within(await rowOf("off-key")).getByRole("button", { name: "Logging" }));
    const editor = await screen.findByTestId("key-logging-editor-1");
    await user.click(within(editor).getAllByRole("checkbox")[0]);
    await within(editor).findByText("forbidden");
  });

  it("does not offer logging controls for a revoked key", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([key({ id: 9, label: "gone", revoked_at: "2026-09-01T00:00:00Z", content_logging_enabled: true })]);
    page();
    const row = await rowOf("gone");
    expect(within(row).queryByRole("button", { name: "Logging" })).toBeNull();
  });
});

describe("Workspace -> creating a key with logging", () => {
  async function fillAndOpen(user: ReturnType<typeof userEvent.setup>) {
    page();
    await user.type(await screen.findByPlaceholderText(/Label/), "new-key");
    return screen.getByTestId("create-key-logging");
  }

  it("defaults both options OFF, keeps images disabled until text is ticked, and sends the choices", async () => {
    vi.mocked(api.createKey).mockResolvedValue({
      id: 9, label: "new-key", key: SECRET, key_prefix: "vk_BRAND_NE", allowed_providers: ["openai"], allow_live: true,
      default_provider: "openai", monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null,
      expires_at: null, created_at: "2026-10-23T00:00:00Z", content_logging_enabled: true, image_logging_enabled: true,
    });
    const user = userEvent.setup();
    const box = await fillAndOpen(user);
    const [text, images] = within(box).getAllByRole("checkbox") as HTMLInputElement[];
    expect(text.checked).toBe(false);
    expect(images.checked).toBe(false);
    expect(images.disabled).toBe(true);

    await user.click(text);
    expect(images.disabled).toBe(false);
    await user.click(images);
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() =>
      expect(api.createKey).toHaveBeenCalledWith(
        expect.objectContaining({ label: "new-key", content_logging_enabled: true, image_logging_enabled: true }),
      ),
    );
    expect(await screen.findByText(SECRET)).toBeTruthy(); // shown once, in the creation box only
    // the options reset for the next key, and the secret is not in the keys table
    expect((within(screen.getByTestId("create-key-logging")).getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(false);
    expect(within(document.querySelector("table")!).queryByText(SECRET)).toBeNull();
  });

  it("creates a key with logging OFF unless the admin ticked it", async () => {
    vi.mocked(api.createKey).mockResolvedValue({
      id: 9, label: "new-key", key: SECRET, key_prefix: "vk_BRAND_NE", allowed_providers: ["openai"], allow_live: true,
      default_provider: "openai", monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null,
      expires_at: null, created_at: "2026-10-23T00:00:00Z",
    });
    const user = userEvent.setup();
    await fillAndOpen(user);
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() =>
      expect(api.createKey).toHaveBeenCalledWith(
        expect.objectContaining({ content_logging_enabled: false, image_logging_enabled: false }),
      ),
    );
  });

  it("unticking text logging also unticks images, and warns when the workspace master is off", async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue(workspace({ text: false, images: false }));
    const user = userEvent.setup();
    const box = await fillAndOpen(user);
    const [text, images] = within(box).getAllByRole("checkbox") as HTMLInputElement[];
    await user.click(text);
    expect(box.textContent).toMatch(/Prompt & response logging is off, so this key won't be logged until an admin turns it on/);
    await user.click(images);
    expect(images.checked).toBe(true);
    await user.click(text); // untick text
    expect(images.checked).toBe(false);
    expect(images.disabled).toBe(true);
  });
});
