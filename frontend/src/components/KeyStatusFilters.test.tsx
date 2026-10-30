import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeyPicker } from "./KeyPicker";
import { KeyUsageTable } from "./KeyUsageTable";
import type { ByKeyRow } from "../lib/api";
import type { KeyOption, KeyStatus } from "../lib/keyOptions";

const KEYS: KeyOption[] = [
  { key_id: 1, label: "sam-anthropic", status: "active" },
  { key_id: 2, label: "old-key", status: "revoked" },
  { key_id: 3, label: "gone-key", status: "deleted" },
];

const picker = (value = "", onChange = vi.fn()) =>
  render(<KeyPicker keys={KEYS} value={value} onChange={onChange} className="" />);
const open = () => userEvent.click(screen.getByRole("combobox", { name: /^Key:/ }));
const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("KeyPicker", () => {
  it("is a combobox named with its current choice, and opens with Active ticked and only active keys listed", async () => {
    picker();
    expect(screen.getByRole("combobox", { name: "Key: All keys" })).toHaveTextContent("All keys"); // the name contains the visible text
    await open();
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Revoked" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deleted" })).not.toBeChecked();
    expect(optionNames()).toEqual(["All keys", "sam-anthropic"]);
  });

  it("lists revoked and deleted keys (labelled) once ticked", async () => {
    picker();
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: "Revoked" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Deleted" }));
    expect(optionNames()).toEqual(["All keys", "sam-anthropic", "old-keyrevoked", "gone-keydeleted"]);
  });

  it("keeps at least one status ticked", async () => {
    picker();
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
  });

  it("picks a key by its id and closes", async () => {
    const onChange = vi.fn();
    picker("", onChange);
    await open();
    await userEvent.click(screen.getByRole("option", { name: "sam-anthropic" }));
    expect(onChange).toHaveBeenCalledWith("1");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("can be searched and chosen from the keyboard: type, then Enter", async () => {
    const onChange = vi.fn();
    picker("", onChange);
    await open();
    const search = screen.getByRole("combobox", { name: "Search key" }) as HTMLInputElement;
    expect(search).toHaveFocus(); // typing works at once, without tabbing into the list
    await userEvent.click(screen.getByRole("checkbox", { name: "Revoked" }));
    await userEvent.type(search, "old");
    expect(optionNames()).toEqual(["old-keyrevoked"]);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("2");
    // Escape and focus return belong to the popover itself: checked in the browser by the UI audit harness
  });

  it("says so when nothing matches the search", async () => {
    picker();
    await open();
    await userEvent.type(screen.getByRole("combobox", { name: "Search key" }), "zzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  it("keeps the chosen key listed and named even when its status is not ticked", async () => {
    picker("3");
    expect(screen.getByRole("combobox", { name: "Key: gone-key" })).toHaveTextContent("gone-key");
    await open();
    expect(optionNames()).toContain("gone-keydeleted");
  });
});

const ROW = (key_id: number, label: string): ByKeyRow => ({
  key_id, label, key_prefix: "vk_abc", requests: 1, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.1, last_used_at: null,
});

describe("KeyUsageTable status filter", () => {
  const status = (id: number): KeyStatus => KEYS.find((k) => k.key_id === id)!.status;
  const table = () => render(<KeyUsageTable rows={[ROW(1, "sam-anthropic"), ROW(2, "old-key"), ROW(3, "gone-key")]} statusOf={status} />);
  const labels = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);

  it("shows only active keys by default, with Active ticked", () => {
    table();
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Revoked" })).not.toBeChecked();
    expect(labels()).toEqual(["sam-anthropic"]);
  });

  it("adds revoked and deleted rows when ticked, marked with their status", async () => {
    table();
    await userEvent.click(screen.getByRole("checkbox", { name: "Revoked" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Deleted" }));
    expect(labels().sort()).toEqual(["gone-keydeleted", "old-keyrevoked", "sam-anthropic"]);
  });

  it("says why it is empty when only other statuses have usage", async () => {
    render(<KeyUsageTable rows={[ROW(2, "old-key")]} statusOf={status} />);
    expect(screen.getByText("No keys with these statuses in this range")).toBeTruthy();
    render(<KeyUsageTable rows={[]} statusOf={status} />);
    expect(screen.getByText("No usage in this range yet")).toBeTruthy();
  });
});
