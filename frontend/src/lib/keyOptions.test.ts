import { describe, expect, it } from "vitest";
import { keyOptions, keyStatus, toggleStatus } from "./keyOptions";

describe("keyOptions", () => {
  it("includes keys that have never made a request", () => {
    const out = keyOptions(
      [{ id: 1, label: "sam-anthropic" }, { id: 2, label: "dhilip-openai" }],
      [{ key_id: 2, label: "dhilip-openai" }],
    );
    expect(out.map((o) => o.label)).toEqual(["dhilip-openai", "sam-anthropic"]);
  });

  it("gives each key its status: deleted wins over revoked, which wins over active", () => {
    const out = keyOptions(
      [
        { id: 1, label: "a" },
        { id: 2, label: "b", revoked_at: "2026-10-01T00:00:00Z" },
        { id: 3, label: "c", revoked_at: "2026-10-01T00:00:00Z", deleted_at: "2026-10-02T00:00:00Z" },
      ],
      [],
    );
    expect(out.map((o) => o.status)).toEqual(["active", "revoked", "deleted"]);
    expect(keyStatus({})).toBe("active");
  });

  it("lists each key once, and a key with usage that the list no longer returns is deleted", () => {
    const out = keyOptions([{ id: 1, label: "a" }], [{ key_id: 1, label: "a" }, { key_id: 9, label: "gone" }]);
    expect(out).toEqual([
      { key_id: 1, label: "a", status: "active" },
      { key_id: 9, label: "gone", status: "deleted" },
    ]);
  });

  it("copes with empty input", () => {
    expect(keyOptions([], [])).toEqual([]);
  });
});

describe("toggleStatus", () => {
  it("adds and removes a status, in a stable order", () => {
    expect(toggleStatus(["active"], "deleted")).toEqual(["active", "deleted"]);
    expect(toggleStatus(["deleted"], "active")).toEqual(["active", "deleted"]);
    expect(toggleStatus(["active", "revoked"], "active")).toEqual(["revoked"]);
  });

  it("never unticks the last one", () => {
    expect(toggleStatus(["active"], "active")).toEqual(["active"]);
  });
});
