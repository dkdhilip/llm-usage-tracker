import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { ThemeProvider } from "../lib/theme";
import { api, type UsageSummary } from "../lib/api";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isWorkspaceAdmin: true, workspace: { name: "Acme" } }),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      models: vi.fn(),
      listKeys: vi.fn(),
      usageSummary: vi.fn(),
      usageTimeseries: vi.fn(),
      usageByKey: vi.fn(),
      usageByModel: vi.fn(),
    },
  };
});

const SUMMARY: UsageSummary = {
  total_requests: 12, total_tokens: 3400, total_prompt_tokens: 1000, total_completion_tokens: 2400, total_cost: 0.5,
  cost_actual: 0, cost_estimated: 0.5, latency_p50_ms: 800, latency_p95_ms: 1900, error_rate: 0, errors: 0, tokens_per_sec: 42, active_keys: 3, unpriced_requests: 0,
};
const NO_USAGE = "No usage in this range yet";

const page = () =>
  render(
    <ThemeProvider>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </ThemeProvider>,
  );

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.models).mockResolvedValue([]);
  vi.mocked(api.listKeys).mockResolvedValue([]);
  vi.mocked(api.usageSummary).mockResolvedValue(SUMMARY);
  vi.mocked(api.usageTimeseries).mockResolvedValue([{ day: "2026-10-26", provider: "openai", requests: 12, total_tokens: 3400, cost: 0.5, unpriced_requests: 0 }]);
  vi.mocked(api.usageByKey).mockResolvedValue([]);
  vi.mocked(api.usageByModel).mockResolvedValue([{ provider: "openai", model: "gpt-4o-mini", requests: 12, total_tokens: 3400, cost: 0.5 }]);
});

describe("Dashboard loading and error states", () => {
  it("never says 'No usage' while the data is still loading", async () => {
    vi.mocked(api.usageSummary).mockReturnValue(new Promise(() => {})); // never settles
    page();
    await waitFor(() => expect(api.usageSummary).toHaveBeenCalled());
    expect(screen.queryByText(NO_USAGE)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces a failed load with the reason and a Retry, and never says 'No usage'", async () => {
    vi.mocked(api.usageSummary).mockRejectedValue(new Error("database unavailable"));
    page();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load usage");
    expect(alert).toHaveTextContent("database unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(NO_USAGE)).toBeNull();
    expect(screen.getAllByText("Couldn't load this data.").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).toBeNull(); // the cards show dashes, not zeros
  });

  it("recovers when Retry succeeds", async () => {
    vi.mocked(api.usageSummary).mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((await screen.findAllByText("12")).length).toBeGreaterThan(0); // the total requests are back
    expect(screen.queryByText("Couldn't load this data.")).toBeNull();
  });

  it("says 'No usage' only when it loaded and there really is none", async () => {
    vi.mocked(api.usageTimeseries).mockResolvedValue([]);
    vi.mocked(api.usageByModel).mockResolvedValue([]);
    vi.mocked(api.usageSummary).mockResolvedValue({ ...SUMMARY, total_requests: 0, total_tokens: 0, total_cost: 0, cost_estimated: 0 });
    page();
    await waitFor(() => expect(screen.getAllByText(NO_USAGE).length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
