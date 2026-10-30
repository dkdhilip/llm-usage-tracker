import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyUsageTable } from "./KeyUsageTable";
import type { ByKeyRow } from "../lib/api";

const ROWS: ByKeyRow[] = [
  { key_id: 1, label: "prod-openai", key_prefix: "vk_abc", requests: 88, prompt_tokens: 100, completion_tokens: 95, total_tokens: 195, cost: 0.37, last_used_at: null },
  { key_id: 2, label: "support-bot", key_prefix: "vk_def", requests: 164, prompt_tokens: 300, completion_tokens: 32, total_tokens: 332, cost: 0.09, last_used_at: null },
  { key_id: 3, label: "dhilip-gemini", key_prefix: "vk_ghi", requests: 54, prompt_tokens: 100, completion_tokens: 27, total_tokens: 127, cost: 0, unpriced_requests: 54, last_used_at: null },
];

function stubPhone(matches: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches, media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("KeyUsageTable on a phone", () => {
  const table = () => render(<KeyUsageTable rows={ROWS} statusOf={() => "active"} />);

  it("is a table on a desktop and has no cards", () => {
    stubPhone(false);
    table();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Sort keys by" })).toBeNull();
  });

  it("is one stacked card per key on a phone, with no table to scroll sideways", () => {
    stubPhone(true);
    table();
    expect(screen.queryByRole("table")).toBeNull();
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    // sorted by cost, the biggest spender first; every fact is in the card
    expect(within(cards[0]).getByText("prod-openai")).toBeInTheDocument();
    expect(within(cards[0]).getByText("vk_abc…")).toBeInTheDocument();
    expect(within(cards[0]).getByText("$0.3700")).toBeInTheDocument();
    expect(within(cards[0]).getByText("88 requests")).toBeInTheDocument();
    expect(within(cards[0]).getByText("195 tokens")).toBeInTheDocument();
    expect(within(cards[0]).getByText(/^Last used/)).toBeInTheDocument();
  });

  it("never shows a key with no price as free", () => {
    stubPhone(true);
    table();
    const card = screen.getAllByRole("listitem").find((c) => within(c).queryByText("dhilip-gemini"))!;
    expect(within(card).getByText("No price yet")).toBeInTheDocument();
    expect(within(card).queryByText("Free")).toBeNull();
  });

  it("re-sorts from the sort control", async () => {
    stubPhone(true);
    table();
    await userEvent.click(screen.getByRole("button", { name: "Requests" }));
    expect(within(screen.getAllByRole("listitem")[0]).getByText("support-bot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requests" })).toHaveAttribute("aria-pressed", "true");
  });
});
