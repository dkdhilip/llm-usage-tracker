import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Playground } from "./Playground";
import { api, type ChatResult, type KeyInspect } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: { models: vi.fn(), inspectKey: vi.fn(), proxyChat: vi.fn(), listKeys: vi.fn() } };
});

const KEY = "vk_demo_key_123";
const inspect = (over: Partial<KeyInspect> = {}): KeyInspect => ({
  label: "prod-openai",
  allow_live: true,
  providers: [{ provider: "openai", ready: true }],
  ...over,
});
const result = (over: Partial<ChatResult> = {}): ChatResult => ({
  request_id: "req-1", provider: "openai", model: "gpt-4o-mini", response: "A gateway sits between apps and models.",
  usage: { prompt_tokens: 29, completion_tokens: 52, total_tokens: 81 }, cost: 0.0004, cost_source: "configured",
  pricing: { input_per_1m: 0.15, output_per_1m: 0.6, source: "configured" }, latency_ms: 1800, ...over,
});

const page = () => render(<MemoryRouter><Playground /></MemoryRouter>);
const typeKey = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("Virtual key"), KEY);
  await screen.findByText("prod-openai · 1 provider allowed");
};
const send = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /^Send request/ }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.models).mockResolvedValue([
    { provider: "openai", model: "gpt-4o-mini", input_per_1m: 0.15, output_per_1m: 0.6 },
    { provider: "openai", model: "gpt-4.1", input_per_1m: 2, output_per_1m: 8 },
  ]);
  vi.mocked(api.inspectKey).mockResolvedValue(inspect());
  vi.mocked(api.proxyChat).mockResolvedValue(result());
  vi.mocked(api.listKeys).mockResolvedValue([]);
});

describe("Playground: before sending", () => {
  it("says what to do first, and why Send does nothing yet", async () => {
    const user = userEvent.setup();
    page();
    expect(screen.getByRole("heading", { level: 1, name: "Playground" })).toBeInTheDocument();
    expect(screen.getByText("Your response will appear here.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /^Send request/ });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Paste a virtual key to start.");
    await user.click(button);
    expect(api.proxyChat).not.toHaveBeenCalled();
  });

  it("warns that this costs money, above the Send button, and explains actual versus estimated", () => {
    page();
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("This sends a real request and costs money");
    expect(note).toHaveTextContent("OpenRouter: actual provider charge");
    expect(note).toHaveTextContent("estimated from our price table");
    const send = screen.getByRole("button", { name: /^Send request/ });
    expect(note.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the warning comes first
  });

  it("confirms a good key in words, and offers only its providers and their models", async () => {
    const user = userEvent.setup();
    page();
    await typeKey(user);
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("openai");
    await waitFor(() => expect(within(screen.getByRole("combobox", { name: "Model" })).getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("button", { name: /^Send request/ })).not.toHaveAttribute("aria-disabled");
  });

  it("announces a bad key, ties the message to the field, and keeps Send inactive", async () => {
    vi.mocked(api.inspectKey).mockRejectedValue(new Error("Invalid virtual key"));
    const user = userEvent.setup();
    page();
    await user.type(screen.getByLabelText("Virtual key"), "vk_nope");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid virtual key");
    const input = screen.getByLabelText("Virtual key");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Invalid virtual key");
    expect(screen.getByRole("button", { name: /^Send request/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("says why a paused key cannot send", async () => {
    vi.mocked(api.inspectKey).mockResolvedValue(inspect({ allow_live: false }));
    const user = userEvent.setup();
    page();
    await user.type(screen.getByLabelText("Virtual key"), KEY);
    expect(await screen.findByText(/Can't send: this key is paused/)).toBeInTheDocument();
    expect(screen.getByText(/· paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send request/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("pastes a key from the clipboard, and says so if the browser refuses", async () => {
    const user = userEvent.setup();
    page();
    await navigator.clipboard.writeText(`  ${KEY}\n`);
    await user.click(screen.getByRole("button", { name: "Paste virtual key from clipboard" }));
    expect(screen.getByLabelText("Virtual key")).toHaveValue(KEY); // trimmed
    vi.spyOn(navigator.clipboard, "readText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Paste virtual key from clipboard" }));
    expect(await screen.findByText(/Couldn't read the clipboard/)).toBeInTheDocument();
  });
});

describe("Playground: sending", () => {
  it("sends the chosen provider, model and prompt with the key, and shows the response with its facts", async () => {
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    const box = await screen.findByRole("region", { name: "Response" });
    expect(api.proxyChat).toHaveBeenCalledWith({ provider: "openai", model: "gpt-4o-mini", prompt: expect.stringContaining("LLM gateway") }, KEY);
    expect(within(box).getByText("A gateway sits between apps and models.")).toBeInTheDocument();
    expect(within(box).getByText("openai/gpt-4o-mini")).toBeInTheDocument();
    expect(within(box).getByText("1.8 s")).toBeInTheDocument();
    expect(within(box).getByText("$0.000400")).toBeInTheDocument();
    expect(within(box).getByText("Estimated")).toBeInTheDocument();
    expect(within(box).getByText("Success")).toBeInTheDocument();
  });

  it("sends with Ctrl+Enter from the prompt, but not while the form is not ready", async () => {
    const user = userEvent.setup();
    page();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(api.proxyChat).not.toHaveBeenCalled(); // no key yet
    await typeKey(user);
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await screen.findByRole("region", { name: "Response" });
    expect(api.proxyChat).toHaveBeenCalledTimes(1);
  });

  it("shows a failed call as an announced error and keeps the form usable", async () => {
    vi.mocked(api.proxyChat).mockRejectedValue(new Error("Provider rejected the request"));
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider rejected the request");
    expect(screen.queryByRole("region", { name: "Response" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Send request/ })).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the newest response on top and names the older ones", async () => {
    vi.mocked(api.proxyChat).mockResolvedValueOnce(result({ request_id: "a", response: "first" })).mockResolvedValueOnce(result({ request_id: "b", response: "second" }));
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    await screen.findByText("first");
    await send(user);
    await screen.findByText("second");
    expect(screen.getByRole("region", { name: "Response" })).toHaveTextContent("second");
    expect(screen.getByRole("region", { name: "Earlier response" })).toHaveTextContent("first");
  });
});

describe("Playground: what a response cost", () => {
  const show = async (r: ChatResult) => {
    vi.mocked(api.proxyChat).mockResolvedValue(r);
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    return within(await screen.findByRole("region", { name: "Response" }));
  };

  it("says Actual charge when the provider reported the real cost", async () => {
    const box = await show(result({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", cost: 0.000187, cost_source: "provider" }));
    expect(box.getByText("Actual charge")).toBeInTheDocument();
    expect(box.getByText("$0.000187")).toBeInTheDocument();
    expect(box.queryByText("Estimated")).toBeNull();
  });

  it("says Estimated when we calculated it from the price table", async () => {
    const box = await show(result({ cost_source: "configured" }));
    expect(box.getByText("Estimated")).toBeInTheDocument();
    expect(box.queryByText("Actual charge")).toBeNull();
  });

  it("says No price yet, never $0, when the model has no price", async () => {
    const box = await show(result({ cost: null, cost_source: "unknown" }));
    expect(box.getByText("No price yet")).toBeInTheDocument();
    expect(box.queryByText(/\$0/)).toBeNull();
    expect(box.queryByText("Estimated")).toBeNull();
  });
});

describe("Playground: after a response", () => {
  it("copies the response", async () => {
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    const box = within(await screen.findByRole("region", { name: "Response" }));
    await user.click(box.getByRole("button", { name: "Copy response" }));
    expect(await navigator.clipboard.readText()).toBe("A gateway sits between apps and models.");
    expect(box.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("links to this key's requests once the key is found, and to the plain list until then", async () => {
    vi.mocked(api.listKeys).mockResolvedValue([
      { id: 9, label: "other", revoked_at: null },
      { id: 7, label: "prod-openai", revoked_at: null },
    ] as never);
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    const box = within(await screen.findByRole("region", { name: "Response" }));
    await waitFor(() => expect(box.getByRole("link", { name: "View in Requests" })).toHaveAttribute("href", "/requests?key_id=7"));
  });

  it("falls back to the full list when the key cannot be looked up", async () => {
    vi.mocked(api.listKeys).mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    page();
    await typeKey(user);
    await send(user);
    const box = within(await screen.findByRole("region", { name: "Response" }));
    expect(box.getByRole("link", { name: "View in Requests" })).toHaveAttribute("href", "/requests");
  });
});
