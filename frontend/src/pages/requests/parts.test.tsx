import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RequestRow } from "../../lib/api";
import { RowCost, StatusBadge } from "./parts";
import { RequestFilters } from "./RequestFilters";

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 1, ts: "2026-10-20T10:00:00Z", request_id: "r", key_id: 1, key_label: "k", key_prefix: "vk_x", provider: "openai",
  model: "gpt-4o-mini", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, cost_source: "configured",
  latency_ms: 1, status: "success", prompt_preview: null, response_preview: null, ...over,
});

describe("a blocked request (stopped before any provider call)", () => {
  it("is a word, not only a colour", () => {
    render(<StatusBadge status="blocked" />);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("is never shown as Free: nothing was charged because nothing was sent", () => {
    render(<RowCost row={row({ status: "blocked", cost: 0 })} />);
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.getByText("Not charged")).toBeInTheDocument();
  });

  it("does not change how ordinary rows read", () => {
    const { unmount } = render(<RowCost row={row({ cost: 0 })} />);
    expect(screen.getByText("Free")).toBeInTheDocument(); // a real $0 on a request that ran
    unmount();
    render(<RowCost row={row({ cost: null })} />);
    expect(screen.getByText("No price yet")).toBeInTheDocument();
  });

  it("can be filtered for", async () => {
    render(<RequestFilters get={() => ""} set={vi.fn()} keys={[]} models={[]} hasFilters={false} onClear={vi.fn()} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Status: All statuses" }));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Blocked");
  });
});
