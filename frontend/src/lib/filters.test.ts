import { describe, expect, it } from "vitest";
import { defaultFilters, describeRange, previousQuery } from "./filters";

describe("describeRange", () => {
  it("says the preset in words", () => {
    expect(describeRange(defaultFilters)).toBe("Last 30 days");
    expect(describeRange({ ...defaultFilters, rangeDays: 7 })).toBe("Last 7 days");
    expect(describeRange({ ...defaultFilters, rangeDays: 0 })).toBe("All time");
  });
  it("shows a custom range as dates", () => {
    expect(describeRange({ ...defaultFilters, start: "2026-10-09", end: "2026-10-30" })).toBe("Oct 9 – Oct 30");
    expect(describeRange({ ...defaultFilters, start: "2026-10-09", end: "" })).toBe("Oct 9 – today");
  });
});

describe("previousQuery: the period just before the chosen one", () => {
  it("is the same length, ends where the chosen period starts, and keeps the other filters", () => {
    const p = previousQuery({ ...defaultFilters, rangeDays: 7, provider: "openai", keyId: "3" })!;
    const q = new URLSearchParams(p.qs);
    const start = Date.parse(q.get("start")!);
    const end = Date.parse(q.get("end")!);
    expect(Math.round((end - start) / 86_400_000)).toBe(7);
    expect(Date.now() - end).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000); // it ended 7 days ago
    expect(q.get("provider")).toBe("openai");
    expect(q.get("key_id")).toBe("3");
    expect(p.label).toBe("previous 7 days");
  });

  it("follows a custom range (inclusive end) and has nothing for all time", () => {
    const p = previousQuery({ ...defaultFilters, start: "2026-10-11", end: "2026-10-20" })!; // 10 days
    const q = new URLSearchParams(p.qs);
    expect(q.get("start")).toBe("2026-10-01T00:00:00.000Z");
    expect(q.get("end")).toBe("2026-10-11T00:00:00.000Z");
    expect(p.label).toBe("previous period");
    expect(previousQuery({ ...defaultFilters, rangeDays: 0 })).toBeNull();
  });
});
