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

describe("FilterBar: range, chips and reset", () => {
  const models = [{ provider: "openai", model: "gpt-4o-mini", input_per_1m: 0, output_per_1m: 0 }];
  const keys = [{ key_id: 7, label: "prod-openai", status: "active" as const }];

  it("marks the chosen range with aria-pressed", () => {
    render(<FilterBar filters={defaultFilters} onChange={vi.fn()} models={models} keys={keys} />);
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows each active filter as a chip that removes just that filter", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar filters={{ ...defaultFilters, provider: "openai", keyId: "7" }} onChange={onChange} models={models} keys={keys} />,
    );
    expect(screen.getByText("Provider: OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Key: prod-openai")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: Key: prod-openai" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keyId: "", provider: "openai" }));
  });

  it("offers Reset filters only when something differs from the default, and clears everything", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar filters={defaultFilters} onChange={onChange} models={models} keys={keys} />);
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    rerender(<FilterBar filters={{ ...defaultFilters, rangeDays: 7, model: "gpt-4o-mini" }} onChange={onChange} models={models} keys={keys} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultFilters });
  });

  it("opens a custom range with named date fields", async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={defaultFilters} onChange={onChange} models={models} keys={keys} />);
    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
    render(<FilterBar filters={{ ...defaultFilters, start: "2026-10-09", end: "2026-10-30" }} onChange={onChange} models={models} keys={keys} />);
    expect(screen.getByLabelText("From date")).toHaveValue("2026-10-09");
    expect(screen.getByLabelText("To date")).toHaveValue("2026-10-30");
  });
});
