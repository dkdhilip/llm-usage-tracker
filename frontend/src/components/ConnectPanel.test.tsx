import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectPanel, envLines, providersFor } from "./ConnectPanel";
import { api, type IntegrationGuideData, type IntegrationProvider, type IntegrationTarget } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: { integrationGuide: vi.fn() } };
});

const ROOTS: Record<IntegrationTarget, string> = { hosted: "https://gw.example.com", local: "http://127.0.0.1:8000" };

function provider(p: "openai" | "anthropic" | "gemini", label: string, root: string): IntegrationProvider {
  const keyVar = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" }[p];
  const urlVar = { openai: "OPENAI_BASE_URL", anthropic: "ANTHROPIC_BASE_URL", gemini: "GOOGLE_GEMINI_BASE_URL" }[p];
  const url = p === "openai" ? `${root}/v1` : root; // only OpenAI's ends in /v1
  const env_vars = [
    { name: keyVar, value: "vk_...", comment: "your virtual key" },
    { name: urlVar, value: url, comment: "the gateway" },
  ];
  return {
    provider: p, label, sdk: "", install: `pip install ${p}`, gateway_url: root, base_url: url, endpoint: "",
    env_vars, env_file: env_vars.map((e) => `# ${e.comment}\n${e.name}=${e.value}`).join("\n"),
    code: `# ${p} code`, model_example: "", notes: [], requirements: [],
  };
}

function guide(target: IntegrationTarget): IntegrationGuideData {
  const root = ROOTS[target];
  return {
    target, gateway_url: root, targets: ROOTS, general_notes: [],
    providers: [provider("openai", "OpenAI", root), provider("anthropic", "Anthropic", root), provider("gemini", "Gemini", root)],
  };
}

beforeEach(() => {
  vi.mocked(api.integrationGuide).mockImplementation(async (t) => guide(t));
});

const key = (allowed: string[]) => ({ allowed_providers: allowed, allow_live: true });

describe("ConnectPanel", () => {
  it("shows only the ticked provider, with just its two .env lines", async () => {
    render(<ConnectPanel keyInfo={key(["openai"])} configuredProviders={["openai"]} />);
    const box = await screen.findByTestId("connect-openai");
    expect(box.textContent).toContain("OPENAI_API_KEY=vk_...");
    expect(box.textContent).toContain("OPENAI_BASE_URL=https://gw.example.com/v1");
    expect(screen.queryByTestId("connect-anthropic")).toBeNull();
    expect(screen.queryByTestId("connect-gemini")).toBeNull();
    // none of the long guide is on screen
    expect(screen.queryByText(/pip install/)).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText(/Live calls are on/)).toBeNull();
  });

  it("gives Anthropic and Gemini the gateway root WITHOUT /v1", async () => {
    render(<ConnectPanel keyInfo={key(["anthropic", "gemini"])} configuredProviders={[]} />);
    const a = await screen.findByTestId("connect-anthropic");
    const g = await screen.findByTestId("connect-gemini");
    expect(a.textContent).toContain("ANTHROPIC_BASE_URL=https://gw.example.com");
    expect(a.textContent).not.toMatch(/ANTHROPIC_BASE_URL=\S*\/v1/);
    expect(g.textContent).toContain("GOOGLE_GEMINI_BASE_URL=https://gw.example.com");
    expect(g.textContent).not.toMatch(/GOOGLE_GEMINI_BASE_URL=\S*\/v1/);
    expect(screen.queryByTestId("connect-openai")).toBeNull();
  });

  it("serves OpenRouter through the OpenAI client and explains the model prefix", async () => {
    render(<ConnectPanel keyInfo={key(["openrouter"])} configuredProviders={[]} />);
    const box = await screen.findByTestId("connect-openai");
    expect(within(box).getByText("OpenRouter (through the OpenAI client)")).toBeTruthy();
    expect(box.textContent).toContain("OPENAI_BASE_URL=https://gw.example.com/v1");
    expect(box.textContent).toMatch(/openrouter\/<vendor>\/<model>/);
  });

  it("labels a key that allows both OpenAI and OpenRouter as one block", async () => {
    render(<ConnectPanel keyInfo={key(["openai", "openrouter"])} configuredProviders={[]} />);
    const box = await screen.findByTestId("connect-openai");
    expect(within(box).getByText("OpenAI and OpenRouter")).toBeTruthy();
    expect(screen.getAllByTestId(/^connect-(openai|anthropic|gemini)$/)).toHaveLength(1);
  });

  it("switches between the hosted and the local gateway", async () => {
    const user = userEvent.setup();
    render(<ConnectPanel keyInfo={key(["openai", "anthropic"])} configuredProviders={[]} />);
    await screen.findByText(/OPENAI_BASE_URL=https:\/\/gw\.example\.com\/v1/);
    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(await screen.findByText(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8000\/v1/)).toBeTruthy();
    expect(screen.getByText(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8000$/m)).toBeTruthy();
    expect(screen.queryByText(/gw\.example\.com/)).toBeNull(); // nothing from the other gateway is left behind
  });

  it("copies both lines of a provider block", async () => {
    const user = userEvent.setup(); // installs a clipboard stub on navigator
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<ConnectPanel keyInfo={key(["openai"])} configuredProviders={[]} />);
    const box = await screen.findByTestId("connect-openai");
    await user.click(within(box).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("OPENAI_API_KEY=vk_...\nOPENAI_BASE_URL=https://gw.example.com/v1");
  });

  it("keeps the full guide one click away, and back again", async () => {
    const user = userEvent.setup();
    render(<ConnectPanel keyInfo={key(["openai"])} configuredProviders={["openai"]} />);
    await screen.findByTestId("connect-openai");
    await user.click(screen.getByRole("button", { name: "Show full setup guide" }));
    expect(await screen.findByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("pip install openai")).toBeTruthy();
    expect(screen.getByText(/Live calls are on/)).toBeTruthy(); // the readiness checklist is still there
    await user.click(screen.getByRole("button", { name: /Back to the short version/ }));
    expect(await screen.findByTestId("connect-openai")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("shows all three providers when it does not know the key, and an error if the guide cannot load", async () => {
    const { unmount } = render(<ConnectPanel configuredProviders={[]} />);
    expect(await screen.findAllByTestId(/^connect-(openai|anthropic|gemini)$/)).toHaveLength(3);
    unmount();
    vi.mocked(api.integrationGuide).mockRejectedValue(new Error("boom"));
    render(<ConnectPanel keyInfo={key(["openai"])} configuredProviders={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("never contains a real secret: only the vk_... placeholder", async () => {
    const { container } = render(<ConnectPanel keyInfo={key(["openai", "anthropic", "gemini"])} configuredProviders={[]} />);
    await screen.findByTestId("connect-gemini");
    expect(container.textContent).toContain("vk_...");
    expect(container.textContent).not.toMatch(/vk_[A-Za-z0-9]{8,}/);
  });
});

describe("helpers", () => {
  it("maps a key's providers to the guide entries it needs", () => {
    expect(providersFor(["openrouter"])).toEqual(["openai"]);
    expect(providersFor(["gemini", "openai"])).toEqual(["openai", "gemini"]);
    expect(providersFor(undefined)).toEqual(["openai", "anthropic", "gemini"]);
    expect(providersFor([])).toEqual([]);
  });

  it("builds .env lines from env_vars, or from the env file when env_vars is empty", () => {
    const p = provider("openai", "OpenAI", "https://x");
    expect(envLines(p)).toEqual(["OPENAI_API_KEY=vk_...", "OPENAI_BASE_URL=https://x/v1"]);
    expect(envLines({ ...p, env_vars: [] })).toEqual(["OPENAI_API_KEY=vk_...", "OPENAI_BASE_URL=https://x/v1"]);
  });
});
