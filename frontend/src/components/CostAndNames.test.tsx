import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryCards } from "./SummaryCards";
import { KeyUsageTable } from "./KeyUsageTable";
import { UsageOverTimeChart, buildDaily, overTimeSummary } from "./UsageOverTimeChart";
import { UsageByModelChart } from "./UsageByModelChart";
import { UsageByProviderChart } from "./UsageByProviderChart";
import type { ByKeyRow, ByModelRow, TimeseriesPoint, UsageSummary } from "../lib/api";
import { ThemeProvider } from "../lib/theme";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

const summary: UsageSummary = {
  total_requests: 12, total_tokens: 3400, total_prompt_tokens: 1000, total_completion_tokens: 2400,
  total_cost: 0.0123, cost_actual: 0, cost_estimated: 0.0123, latency_p50_ms: 800, latency_p95_ms: 1900,
  error_rate: 0, errors: 0, tokens_per_sec: 42, active_keys: 3,
};

describe("Cost card with unpriced requests", () => {
  it("says how many requests have no price instead of letting a low total look complete", () => {
    render(<SummaryCards data={{ ...summary, unpriced_requests: 5 }} loading={false} />);
    expect(screen.getByText("$0.0123")).toBeInTheDocument();
    expect(screen.getByText(/5 requests have no price yet/)).toBeInTheDocument();
  });

  it("says 'No price yet' (not $0.000000) when no request has a price", () => {
    render(<SummaryCards data={{ ...summary, total_cost: 0, cost_estimated: 0, unpriced_requests: 12 }} loading={false} />);
    expect(screen.getByText("No price yet")).toBeInTheDocument();
    expect(screen.queryByText("$0.000000")).toBeNull();
    expect(screen.getByText("12 requests have no price yet")).toBeInTheDocument();
  });

  it("calls requests priced at exactly $0 free", () => {
    render(<SummaryCards data={{ ...summary, total_cost: 0, cost_estimated: 0, unpriced_requests: 0 }} loading={false} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
  });
});

const ROW = (key_id: number, label: string, cost: number, unpriced?: number): ByKeyRow => ({
  key_id, label, key_prefix: "vk_abc", requests: 4, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost,
  last_used_at: null, unpriced_requests: unpriced,
});

describe("Per-key usage cost column", () => {
  const cells = () =>
    within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent);

  it("tells no price, free, partly priced and priced apart, and never shows $0.000000", () => {
    render(
      <KeyUsageTable
        rows={[ROW(1, "gemini-key", 0, 4), ROW(2, "free-key", 0, 0), ROW(3, "part-key", 0.02, 1), ROW(4, "paid-key", 1.5, 0)]}
        statusOf={() => "active"}
      />,
    );
    expect(cells().sort()).toEqual(["$0.0200+1 unpriced", "$1.50", "Free", "No price yet"].sort());
    expect(screen.queryByText("$0.000000")).toBeNull();
  });
});

describe("Cost view of the chart: unknown, free and partly priced", () => {
  const pt = (provider: string, requests: number, cost: number, unpriced: number): TimeseriesPoint => ({
    day: "2026-10-26", provider, requests, total_tokens: requests * 100, cost, unpriced_requests: unpriced,
  });
  const costView = async (data: TimeseriesPoint[]) => {
    render(<ThemeProvider><UsageOverTimeChart data={data} /></ThemeProvider>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cost" }));
  };

  it("says 'No price yet' when nothing is priced, 'Free' when priced at $0, never $0.000000", async () => {
    await costView([pt("gemini", 4, 0, 4), pt("openai", 3, 0, 0), pt("anthropic", 2, 0.5, 0)]);
    expect(within(screen.getByTestId("usage-legend-gemini")).getByText("No price yet")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-openai")).getByText("Free")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-anthropic")).getByText("$0.5000")).toBeTruthy();
    expect(screen.queryByText("$0.000000")).toBeNull();
  });

  it("shows the amount with how many requests lack a price when only some do", async () => {
    await costView([pt("openrouter", 5, 0.02, 2)]);
    const legend = within(screen.getByTestId("usage-legend-openrouter"));
    expect(legend.getByText(/0\.0200/)).toBeTruthy();
    expect(legend.getByText("+2 unpriced")).toBeTruthy();
  });

  it("puts 'No price yet' in the spoken summary instead of $0", () => {
    const d = buildDaily([pt("gemini", 2, 0, 2)], "cost");
    expect(overTimeSummary(d, "cost")).toContain("Gemini No price yet");
  });
});

describe("provider names", () => {
  it("are written as brands in the chart legend and the provider ring", () => {
    const data: TimeseriesPoint[] = ["openai", "openrouter", "gemini", "anthropic"].map((p) => ({
      day: "2026-10-26", provider: p, requests: 2, total_tokens: 200, cost: 0.1, unpriced_requests: 0,
    }));
    const { unmount } = render(<ThemeProvider><UsageOverTimeChart data={data} /></ThemeProvider>);
    for (const n of ["OpenAI", "OpenRouter", "Gemini", "Anthropic"]) expect(screen.getByText(n)).toBeTruthy();
    expect(screen.queryByText("Openai")).toBeNull();
    unmount();

    const models: ByModelRow[] = ["openai", "openrouter"].map((p) => ({
      provider: p, model: `${p}-m`, requests: 1, total_tokens: 100, cost: 0,
    }));
    render(<ThemeProvider><UsageByProviderChart data={models} /><UsageByModelChart data={models} /></ThemeProvider>);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenRouter").length).toBeGreaterThan(0);
    expect(screen.queryByText("Openrouter")).toBeNull();
  });
});

describe("charts have text alternatives", () => {
  it("the time chart is an image with its summary as the name", () => {
    const data: TimeseriesPoint[] = [
      { day: "2026-10-22", provider: "openai", requests: 4, total_tokens: 400, cost: 0.1, unpriced_requests: 0 },
      { day: "2026-10-23", provider: "openai", requests: 9, total_tokens: 900, cost: 0.2, unpriced_requests: 0 },
    ];
    render(<ThemeProvider><UsageOverTimeChart data={data} /></ThemeProvider>);
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("Requests per day over 2 days, 13 in total.");
    expect(label).toContain("Busiest day Oct 23 with 9.");
    expect(label).toContain("By provider: OpenAI 13.");
  });

  it("the provider share and the model bars are lists of text, so nothing is only a drawing", () => {
    const models = [
      { provider: "openai", model: "gpt-4o-mini", requests: 1, total_tokens: 750, cost: 0 },
      { provider: "gemini", model: "gemini-3.8-flash", requests: 1, total_tokens: 250, cost: 0 },
    ];
    render(<ThemeProvider><UsageByProviderChart data={models} /><UsageByModelChart data={models} /></ThemeProvider>);
    const share = within(screen.getByRole("list", { name: "Provider share of tokens" })).getAllByRole("listitem");
    expect(share.map((i) => i.textContent)).toEqual(["OpenAI75075%", "Gemini25025%"]);
    const bars = within(screen.getByRole("list", { name: "Tokens by model, most first" })).getAllByRole("listitem");
    expect(bars[0].textContent).toContain("OpenAI: gpt-4o-mini"); // the provider is named in text, not only by colour
    expect(bars[0].textContent).toContain("750");
  });

  it("shows the top 8 models and the rest on request", async () => {
    const models = Array.from({ length: 10 }, (_, i) => ({
      provider: "openai", model: `m${i}`, requests: 1, total_tokens: 1000 - i, cost: 0,
    }));
    render(<ThemeProvider><UsageByModelChart data={models} /></ThemeProvider>);
    const list = () => within(screen.getByRole("list", { name: "Tokens by model, most first" })).getAllByRole("listitem");
    expect(list()).toHaveLength(8);
    await userEvent.click(screen.getByRole("button", { name: "Show all 10 models" }));
    expect(list()).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Show top 8" })).toHaveAttribute("aria-expanded", "true");
  });
});
