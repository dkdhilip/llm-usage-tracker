import { describe, expect, it } from "vitest";
import { keyOptions } from "./keyOptions";

describe("keyOptions", () => {
  it("includes keys that have never made a request", () => {
    const out = keyOptions(
      [{ id: 1, label: "sam-anthropic" }, { id: 2, label: "dhilip-openai" }],
      [{ key_id: 2, label: "dhilip-openai" }],
    );
    expect(out.map((o) => o.label)).toEqual(["dhilip-openai", "sam-anthropic"]);
  });

  it("lists each key once and keeps a deleted key only when it has usage", () => {
    const out = keyOptions(
      [{ id: 1, label: "a" }, { id: 3, label: "gone-unused", deleted_at: "2026-10-01T00:00:00Z" }, { id: 4, label: "gone-used", deleted_at: "2026-10-01T00:00:00Z" }],
      [{ key_id: 1, label: "a" }, { key_id: 4, label: "gone-used" }],
    );
    expect(out.map((o) => o.key_id)).toEqual([1, 4]);
  });

  it("copes with empty input", () => {
    expect(keyOptions([], [])).toEqual([]);
  });
});
