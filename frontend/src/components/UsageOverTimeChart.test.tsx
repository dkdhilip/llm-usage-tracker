import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DayTooltip, UsageOverTimeChart, buildDaily, dayLabel, formatMetric } from "./UsageOverTimeChart";
import type { TimeseriesPoint } from "../lib/api";
import { ThemeProvider } from "../lib/theme";

const chart = (data: TimeseriesPoint[]) => render(<ThemeProvider><UsageOverTimeChart data={data} /></ThemeProvider>);

const pt = (day: string, provider: string, requests: number, total_tokens = requests * 100, cost = requests * 0.001): TimeseriesPoint => ({
  day, provider, requests, total_tokens, cost,
});

// three days with usage, two days of nothing between the 3rd and the 6th
const DATA = [
  pt("2026-10-22", "openrouter", 4),
  pt("2026-10-22", "openai", 1),
  pt("2026-10-23", "openrouter", 20),
  pt("2026-10-26", "openai", 3),
  pt("2026-10-26", "gemini", 2),
];

describe("buildDaily", () => {
  it("has one row for every calendar day, with the empty days at zero", () => {
    const { rows } = buildDaily(DATA, "requests");
    expect(rows.map((r) => r.day)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(rows[2].total).toBe(0);
    expect(rows[3].total).toBe(0);
    expect(rows[1].openrouter).toBe(20);
    expect(rows[1].openai).toBe(0); // a provider with nothing that day is 0, never missing
  });

  it("orders providers by their period total, largest first, and totals each one", () => {
    const { providers, totals, grand, requests } = buildDaily(DATA, "requests");
    expect(providers).toEqual(["openrouter", "openai", "gemini"]);
    expect(Object.fromEntries(totals)).toEqual({ openrouter: 24, openai: 4, gemini: 2 });
    expect(grand).toBe(30);
    expect(requests).toBe(30);
  });

  it("uses the chosen unit", () => {
    expect(buildDaily(DATA, "total_tokens").grand).toBe(3000);
    expect(buildDaily(DATA, "cost").grand).toBeCloseTo(0.03);
  });

  it("does not stretch a very long range into hundreds of empty days", () => {
    const { rows } = buildDaily([pt("2026-01-01", "openai", 1), pt("2026-09-01", "openai", 1)], "requests");
    expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-09-01"]);
  });

  it("handles one day, and no data", () => {
    expect(buildDaily([pt("2026-10-26", "openai", 2)], "requests").rows).toHaveLength(1);
    const empty = buildDaily([], "cost");
    expect(empty.rows).toEqual([]);
    expect(empty.grand).toBe(0);
  });

  it("fills across a month boundary and a leap day correctly", () => {
    const { rows } = buildDaily([pt("2028-02-27", "openai", 1), pt("2028-03-02", "openai", 1)], "requests");
    expect(rows.map((r) => r.day)).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02"]);
  });
});

describe("labels", () => {
  it("writes days short and never shifts them with the time zone", () => {
    expect(dayLabel("2026-10-26")).toBe("Oct 26");
    expect(dayLabel("2026-01-01")).toBe("Jan 1");
    expect(dayLabel("2026-10-26", true)).toBe("Mon, Oct 26");
  });

  it("formats each unit", () => {
    expect(formatMetric("requests", 1234)).toBe("1,234");
    expect(formatMetric("total_tokens", 12_500)).toBe("12.5K");
    expect(formatMetric("cost", 0.000152)).toBe("$0.000152");
  });
});

describe("UsageOverTimeChart", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver, which recharts' ResponsiveContainer needs
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  it("leads with the total and gives every provider its own number", () => {
    chart(DATA);
    expect(screen.getByTestId("usage-total")).toHaveTextContent("30");
    expect(screen.getByText("requests over 5 days")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-openrouter")).getByText("24")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-openai")).getByText("4")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-gemini")).getByText("2")).toBeTruthy();
  });

  it("starts on requests (complete for every provider) and switches to tokens and cost", async () => {
    const user = userEvent.setup();
    chart(DATA);
    expect(screen.getByRole("button", { name: "Requests" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("3.0K");
    expect(screen.getByText("tokens over 5 days · 30 requests")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cost" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("$0.0300");
    expect(within(screen.getByTestId("usage-legend-gemini")).getByText("$0.002000")).toBeTruthy();
  });

  it("never shows $0 for a provider whose requests have no cost: that is 'no price yet', not free", async () => {
    const user = userEvent.setup();
    chart([pt("2026-10-26", "openrouter", 3), { ...pt("2026-10-26", "gemini", 2), cost: 0 }]);
    await user.click(screen.getByRole("button", { name: "Cost" }));
    expect(within(screen.getByTestId("usage-legend-gemini")).getByText("No price yet")).toBeTruthy();
    expect(within(screen.getByTestId("usage-legend-openrouter")).queryByText("No price yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Requests" }));
    expect(within(screen.getByTestId("usage-legend-gemini")).getByText("2")).toBeTruthy(); // other units unaffected
  });

  it("says so plainly when there is no usage", () => {
    chart([]);
    expect(screen.getByText("No usage in this range yet")).toBeTruthy();
    expect(screen.queryByTestId("usage-total")).toBeNull();
  });

  it("reads correctly for a single day and a single request", () => {
    chart([pt("2026-10-26", "openai", 1)]);
    expect(screen.getByText("requests over 1 day")).toBeTruthy();
  });
});

describe("DayTooltip", () => {
  const payload = [
    { dataKey: "openai", value: 3, color: "#10a37f" },
    { dataKey: "gemini", value: 0, color: "#3b82f6" },
    { dataKey: "openrouter", value: 20, color: "#6366f1" },
  ];

  it("shows the day, the providers that had usage (largest first) and the total", () => {
    render(<DayTooltip active payload={payload} label="2026-10-26" metric="requests" />);
    expect(screen.getByText("Mon, Oct 26")).toBeTruthy();
    const names = screen.getAllByTestId("tip-name").map((n) => n.textContent);
    expect(names).toEqual(["OpenRouter", "OpenAI"]); // gemini had 0 that day: left out
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("23")).toBeTruthy();
  });

  it("says 'No usage' for an empty day and renders nothing when inactive", () => {
    const { container, rerender } = render(
      <DayTooltip active payload={payload.map((p) => ({ ...p, value: 0 }))} label="2026-10-25" metric="requests" />,
    );
    expect(screen.getByText("No usage")).toBeTruthy();
    rerender(<DayTooltip active={false} payload={payload} label="2026-10-26" metric="requests" />);
    expect(container.textContent).toBe("");
  });

  it("leaves the total out when only one provider had usage", () => {
    render(<DayTooltip active payload={[payload[2]]} label="2026-10-23" metric="requests" />);
    expect(screen.queryByText("Total")).toBeNull();
  });
});
