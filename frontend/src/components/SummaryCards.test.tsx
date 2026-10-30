import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SummaryCards, successRate } from "./SummaryCards";
import type { UsageSummary } from "../lib/api";

const base: UsageSummary = {
  total_requests: 12,
  total_tokens: 3400,
  total_prompt_tokens: 1000,
  total_completion_tokens: 2400,
  total_cost: 0.0123,
  cost_actual: 0,
  cost_estimated: 0.0123,
  latency_p50_ms: 800,
  latency_p95_ms: 1900,
  error_rate: 0,
  errors: 0,
  tokens_per_sec: 42,
  active_keys: 3,
};

describe("SummaryCards", () => {
  it("shows a loading skeleton when data is null", () => {
    const { container } = render(<SummaryCards data={null} loading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBe(4);
  });

  it("renders totals and the estimated-only cost hint", () => {
    render(<SummaryCards data={base} loading={false} />);
    expect(screen.getByText("Requests")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(/estimated from configured pricing/i)).toBeInTheDocument();
  });

  it("splits actual vs estimated cost when real spend exists", () => {
    render(
      <SummaryCards data={{ ...base, cost_actual: 0.004, cost_estimated: 0.008 }} loading={false} />,
    );
    expect(screen.getByText(/actual/i)).toBeInTheDocument();
    expect(screen.getByText(/est\./i)).toBeInTheDocument();
  });
});

describe("SummaryCards: cost leads, and says what it does not know", () => {
  it("puts the cost first, labelled as an estimate unless real spend exists", () => {
    const { rerender } = render(<SummaryCards data={base} loading={false} />);
    expect(screen.getAllByText(/^(Estimated cost|Requests|Tokens|Active keys)$/).map((e) => e.textContent)).toEqual([
      "Estimated cost", "Requests", "Tokens", "Active keys",
    ]);
    rerender(<SummaryCards data={{ ...base, cost_actual: 0.004 }} loading={false} />);
    expect(screen.getByText("Cost")).toBeInTheDocument();
  });

  it("warns that the real total is higher when some requests have no price", () => {
    render(<SummaryCards data={{ ...base, unpriced_requests: 5 }} loading={false} />);
    expect(screen.getByText("5 requests have no price yet, so the real total is higher")).toBeInTheDocument();
  });

  it("shows the errors and the success rate on the Requests card", () => {
    render(<SummaryCards data={{ ...base, total_requests: 477, errors: 2 }} loading={false} />);
    expect(screen.getByText("2 errors · 99.5% success")).toBeInTheDocument();
  });

  it("says there were no errors rather than printing nothing", () => {
    render(<SummaryCards data={base} loading={false} />);
    expect(screen.getByText("No errors")).toBeInTheDocument();
  });

  it("never rounds the success rate up to 100% while a request failed", () => {
    expect(successRate(10_000, 1)).toBe("99.9%");
    expect(successRate(10, 0)).toBe("100.0%");
    expect(successRate(0, 0)).toBe("—");
  });

  it("shows dashes, never zeros, when the data failed to load", () => {
    render(<SummaryCards data={null} loading={false} error />);
    expect(screen.getAllByText("—")).toHaveLength(4);
  });
});
