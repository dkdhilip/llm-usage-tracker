import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationGuide, keyReadiness } from "./IntegrationGuide";
import { api, type IntegrationGuideData, type IntegrationProvider, type IntegrationTarget } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: { ...real.api, integrationGuide: vi.fn() } };
});

const ROOTS: Record<IntegrationTarget, string> = {
  hosted: "https://gw.example.com",
  local: "http://127.0.0.1:8000",
};

// Mirrors the shape (and the wording that matters) of what GET /api/integration returns.
function guide(target: IntegrationTarget): IntegrationGuideData {
  const root = ROOTS[target];
  const mk = (
    provider: "openai" | "anthropic" | "gemini",
    label: string,
    base: string,
    endpoint: string,
    notes: string[],
    extra: Partial<IntegrationProvider> = {},
  ) => ({
    provider,
    label,
    sdk: `${provider} (Python)`,
    install: `pip install ${provider} python-dotenv`,
    gateway_url: root,
    base_url: base,
    endpoint: `POST ${root}${endpoint}`,
    env_vars: [],
    env_file: `# your gateway VIRTUAL key\n${provider.toUpperCase()}_API_KEY=vk_...\n${provider.toUpperCase()}_BASE_URL=${base}`,
    code: `# ${provider} snippet for ${root}\nclient = make_${provider}_client()`,
    model_example: "m",
    notes,
    requirements: [],
    ...extra,
  });
  return {
    target,
    gateway_url: root,
    targets: ROOTS,
    general_notes: [
      "A virtual key does not redirect an SDK by itself: your app must be configured with the gateway URL.",
      "A virtual key is shown only once, when it is created. These snippets use the placeholder vk_...",
      "Add .env to .gitignore and never commit a key. Real provider credentials belong in the gateway workspace.",
    ],
    providers: [
      mk("openai", "OpenAI", `${root}/v1`, "/v1/chat/completions", ["The base URL ends in /v1."], {
        intro:
          "Already using the OpenAI SDK? In your project's .env, replace your existing OPENAI_API_KEY with this virtual key and add OPENAI_BASE_URL — your existing client = OpenAI() code then talks to the gateway.",
        alt_title: "3b. Alternative: explicit configuration (fails closed)",
        alt_code: `# explicit configuration for ${root}\nclient = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.environ["OPENAI_BASE_URL"])`,
      }),
      mk("anthropic", "Anthropic", root, "/v1/messages", ["Ending it in /v1 makes the SDK post to /v1/v1/messages (404)."]),
      mk("gemini", "Gemini", root, "/v1beta/models/<model>:generateContent", ["If GOOGLE_API_KEY is set it overrides GEMINI_API_KEY."]),
    ],
  };
}

const READY = { allowed_providers: ["openai", "anthropic", "gemini"], allow_live: true };
const mocked = vi.mocked(api.integrationGuide);

beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(async (t) => guide(t));
});
afterEach(() => vi.unstubAllGlobals());

describe("IntegrationGuide", () => {
  it("opens on the key's first enabled provider and shows install, .env and the request", async () => {
    render(<IntegrationGuide keyInfo={{ allowed_providers: ["anthropic", "gemini"], allow_live: true }} configuredProviders={["anthropic"]} />);
    expect(await screen.findByText(/anthropic snippet for https:\/\/gw\.example\.com/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("pip install anthropic python-dotenv")).toBeInTheDocument();
    expect(screen.getByText(/ANTHROPIC_BASE_URL=https:\/\/gw\.example\.com$/m)).toBeInTheDocument();
    expect(screen.getByText("POST https://gw.example.com/v1/messages")).toBeInTheDocument();
  });

  it("switches providers, each with its own URL form and notes", async () => {
    const user = userEvent.setup();
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai", "anthropic", "gemini"]} />);
    expect(await screen.findByText(/OPENAI_BASE_URL=https:\/\/gw\.example\.com\/v1$/m)).toBeInTheDocument(); // OpenAI: root + /v1

    await user.click(screen.getByRole("tab", { name: "Anthropic" }));
    expect(screen.getByText(/ANTHROPIC_BASE_URL=https:\/\/gw\.example\.com$/m)).toBeInTheDocument(); // root only
    expect(screen.getByText(/\/v1\/v1\/messages/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Gemini" }));
    expect(screen.getByText("POST https://gw.example.com/v1beta/models/<model>:generateContent")).toBeInTheDocument();
    expect(screen.getByText(/GOOGLE_API_KEY is set/)).toBeInTheDocument();
  });

  it("switches between the hosted and local gateway", async () => {
    const user = userEvent.setup();
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    expect(await screen.findByText("https://gw.example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hosted" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(await screen.findByText("http://127.0.0.1:8000")).toBeInTheDocument();
    expect(mocked).toHaveBeenLastCalledWith("local");
    expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8000\/v1$/m)).toBeInTheDocument();
  });

  it("only ever shows the placeholder key — and never a key it was handed by mistake", async () => {
    // keyInfo is typed to carry no key; this guards against anyone threading the secret through anyway.
    const withSecret = { ...READY, key: "vk_SECRET_SHOULD_NEVER_APPEAR_123" } as typeof READY;
    const { container } = render(<IntegrationGuide keyInfo={withSecret} configuredProviders={["openai"]} />);
    await screen.findByText(/openai snippet/);
    expect(container.textContent).toContain("vk_...");
    expect(container.textContent).not.toContain("SECRET_SHOULD_NEVER_APPEAR");
    expect(container.innerHTML).not.toContain("SECRET_SHOULD_NEVER_APPEAR");
  });

  it("OpenAI: says to replace the existing key and add the base URL, and keeps an explicit alternative", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);

    expect(await screen.findByText(/replace your existing OPENAI_API_KEY with this virtual key and add OPENAI_BASE_URL/)).toBeInTheDocument();
    expect(screen.getByText(/existing client = OpenAI\(\) code then talks to the gateway/)).toBeInTheDocument();
    expect(screen.getByText("3. Minimal request")).toBeInTheDocument();
    expect(screen.getByText("3b. Alternative: explicit configuration (fails closed)")).toBeInTheDocument();
    expect(screen.getByText(/client = OpenAI\(api_key=os\.environ\["OPENAI_API_KEY"\], base_url=/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy 3b. Alternative: explicit configuration (fails closed)" }));
    expect(writeText).toHaveBeenLastCalledWith(guide("hosted").providers[0].alt_code);
  });

  it("OpenAI keeps both gateways: the hosted URL and the local URL each end in /v1", async () => {
    const user = userEvent.setup();
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    expect(await screen.findByText(/OPENAI_BASE_URL=https:\/\/gw\.example\.com\/v1$/m)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(await screen.findByText(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8000\/v1$/m)).toBeInTheDocument();
    expect(screen.getByText(/explicit configuration for http:\/\/127\.0\.0\.1:8000/)).toBeInTheDocument();
  });

  it("Anthropic and Gemini are unchanged: no OpenAI intro and no alternative snippet", async () => {
    const user = userEvent.setup();
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai", "anthropic", "gemini"]} />);
    await screen.findByText(/Already using the OpenAI SDK/);

    for (const name of ["Anthropic", "Gemini"]) {
      await user.click(screen.getByRole("tab", { name }));
      expect(screen.queryByText(/Already using the OpenAI SDK/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^3b\./)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Copy 3b\./ })).not.toBeInTheDocument();
      expect(screen.getByText("3. Minimal request")).toBeInTheDocument();
    }
  });

  it("shows the warnings: not automatic, shown once, never commit, real keys stay in the gateway", async () => {
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    expect(await screen.findByText(/does not redirect an SDK by itself/)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(screen.getByText(/never commit a key/)).toBeInTheDocument();
    expect(screen.getByText(/credentials belong in the gateway workspace/)).toBeInTheDocument();
  });

  it("copies exactly what is shown", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    await screen.findByText(/openai snippet/);

    await user.click(screen.getByRole("button", { name: "Copy 3. Minimal request" }));
    expect(writeText).toHaveBeenLastCalledWith(guide("hosted").providers[0].code);
    await user.click(screen.getByRole("button", { name: "Copy 2. .env (git-ignored)" }));
    expect(writeText).toHaveBeenLastCalledWith(guide("hosted").providers[0].env_file);
    expect(screen.getByRole("button", { name: "Copy 2. .env (git-ignored)" })).toHaveTextContent("Copied");
  });

  it("shows a clear error when the guide can't be loaded", async () => {
    mocked.mockRejectedValue(new Error("403 forbidden"));
    render(<IntegrationGuide keyInfo={READY} configuredProviders={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("403 forbidden");
  });

  it("drops the other gateway's snippets while a new target loads, and when it fails to load", async () => {
    const user = userEvent.setup();
    let resolveLocal!: (g: IntegrationGuideData) => void;
    mocked.mockImplementation((t) => (t === "local" ? new Promise((r) => { resolveLocal = r; }) : Promise.resolve(guide(t))));
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    expect(await screen.findByText(/openai snippet for https:\/\/gw\.example\.com/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Local" }));
    // loading: Local is selected, but nothing from the hosted gateway may be shown or copied
    expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/gw\.example\.com/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Copy / })).not.toBeInTheDocument();

    await act(async () => resolveLocal(guide("local")));
    expect(await screen.findByText(/openai snippet for http:\/\/127\.0\.0\.1:8000/)).toBeInTheDocument();

    // failure: switching back and failing must not leave the local snippets under the Hosted toggle
    mocked.mockImplementation(async () => {
      throw new Error("502 bad gateway");
    });
    await user.click(screen.getByRole("button", { name: "Hosted" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("502 bad gateway");
    expect(screen.getByRole("button", { name: "Hosted" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/127\.0\.0\.1:8000/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Copy / })).not.toBeInTheDocument();
  });
});

describe("readiness checklist", () => {
  const okOf = (label: RegExp) => screen.getByText(label).closest("li")!.getAttribute("data-ok");

  it("is all green when the provider is enabled, the key is live, and the workspace holds a credential", async () => {
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    const list = await screen.findByRole("list", { name: "Readiness" });
    const items = within(list).getAllByRole("listitem").filter((li) => li.hasAttribute("data-ok"));
    expect(items).toHaveLength(3);
    expect(items.every((li) => li.getAttribute("data-ok") === "true")).toBe(true);
  });

  it("flags a provider the key does not allow", async () => {
    render(<IntegrationGuide keyInfo={{ allowed_providers: ["openai"], allow_live: true }} configuredProviders={["openai", "anthropic"]} />);
    await screen.findByText(/openai snippet/);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Anthropic" }));
    expect(okOf(/Anthropic is enabled for this key/)).toBe("false");
    expect(screen.getByText(/Create a key that allows this provider/)).toBeInTheDocument();
  });

  it("flags a paused key", async () => {
    render(<IntegrationGuide keyInfo={{ allowed_providers: ["openai"], allow_live: false }} configuredProviders={["openai"]} />);
    await screen.findByText(/openai snippet/);
    expect(okOf(/Live calls are on/)).toBe("false");
    expect(screen.getByText(/paused key answers 403/)).toBeInTheDocument();
  });

  it("flags a missing workspace credential and says it must stay in the gateway", async () => {
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["anthropic"]} />);
    await screen.findByText(/openai snippet/);
    expect(okOf(/workspace holds a real OpenAI credential/)).toBe("false");
    expect(screen.getByText(/never in your application/)).toBeInTheDocument();
  });

  it("explains the model allow-list", async () => {
    render(<IntegrationGuide keyInfo={READY} configuredProviders={["openai"]} />);
    expect(await screen.findByText(/model allow-list; a model outside it answers 403/)).toBeInTheDocument();
  });

  it("flags an expired key, and shows a future expiry as fine", async () => {
    const { unmount } = render(<IntegrationGuide keyInfo={{ ...READY, expires_at: "2020-01-01T00:00:00Z" }} configuredProviders={["openai"]} />);
    await screen.findByText(/openai snippet/);
    expect(okOf(/This key expired on/)).toBe("false");
    expect(screen.getByText(/expired key is refused with a 401/)).toBeInTheDocument();
    unmount();

    render(<IntegrationGuide keyInfo={{ ...READY, expires_at: "2999-01-01T00:00:00Z" }} configuredProviders={["openai"]} />);
    await screen.findByText(/openai snippet/);
    expect(okOf(/The key has not expired/)).toBe("true");
  });

  it("adds no expiry line for a key that never expires", async () => {
    render(<IntegrationGuide keyInfo={{ ...READY, expires_at: null }} configuredProviders={["openai"]} />);
    const list = await screen.findByRole("list", { name: "Readiness" });
    expect(within(list).getAllByRole("listitem").filter((li) => li.hasAttribute("data-ok"))).toHaveLength(3);
    expect(screen.queryByText(/expire/i)).not.toBeInTheDocument();
  });

  it("is omitted when there is no key context", async () => {
    render(<IntegrationGuide configuredProviders={[]} />);
    await screen.findByText(/openai snippet/);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Readiness" })).not.toBeInTheDocument());
  });
});

describe("keyReadiness", () => {
  it("reports each requirement independently", () => {
    expect(keyReadiness("gemini", "Gemini", { allowed_providers: ["openai"], allow_live: false }, []).map((c) => c.ok)).toEqual([false, false, false]);
    expect(keyReadiness("openai", "OpenAI", { allowed_providers: ["openai"], allow_live: true }, ["openai"]).map((c) => c.ok)).toEqual([true, true, true]);
  });

  it("adds an expiry check only for a key that has an expiry, and fails it once that has passed", () => {
    const base = { allowed_providers: ["openai"], allow_live: true };
    const withExpiry = (expires_at: string | null) => keyReadiness("openai", "OpenAI", { ...base, expires_at }, ["openai"]).map((c) => c.ok);
    expect(withExpiry(null)).toEqual([true, true, true]);
    expect(withExpiry("2999-01-01T00:00:00Z")).toEqual([true, true, true, true]);
    expect(withExpiry("2020-01-01T00:00:00Z")).toEqual([true, true, true, false]);
  });
});
