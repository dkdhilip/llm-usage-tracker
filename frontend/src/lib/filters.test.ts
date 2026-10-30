import { describe, expect, it } from "vitest";
import { defaultFilters, describeRange } from "./filters";

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
