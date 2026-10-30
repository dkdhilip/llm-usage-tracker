import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";
import { defaultFilters } from "../lib/filters";

describe("FilterBar", () => {
  it("fires onChange with the selected range preset", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={onChange}
        models={[{ provider: "openrouter", model: "m", input_per_1m: 0, output_per_1m: 0 }]}
        keys={[]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rangeDays: 7 }),
    );
  });

  it("names every dropdown, so a screen reader says what each one filters", () => {
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={vi.fn()}
        models={[{ provider: "openai", model: "gpt-4o-mini", input_per_1m: 0, output_per_1m: 0 }]}
        keys={[{ key_id: 1, label: "k", status: "active" }]}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeTruthy();
    // each name contains what is shown on the control, so voice control and screen readers agree
    expect(screen.getByRole("combobox", { name: "Model: All models" })).toHaveTextContent("All models");
    expect(screen.getByRole("combobox", { name: "Key: All keys" })).toHaveTextContent("All keys");
  });

  it("writes provider names as brands in the Provider dropdown", () => {
    render(
      <FilterBar
        filters={defaultFilters}
        onChange={vi.fn()}
        models={["openai", "openrouter"].map((p) => ({ provider: p, model: "m", input_per_1m: 0, output_per_1m: 0 }))}
        keys={[]}
      />,
    );
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toContain("OpenAI");
    expect(names).toContain("OpenRouter");
  });
});
