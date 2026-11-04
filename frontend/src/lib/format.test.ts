import { describe, expect, it } from "vitest";
import { costLabel, providerName, usdShort } from "./format";

describe("usdShort: whole cents for a table", () => {
  it("shows two decimals, and never a tiny cost as $0.00", () => {
    expect(usdShort(0)).toBe("$0.00");
    expect(usdShort(0.000859)).toBe("<$0.01");
    expect(usdShort(0.00288)).toBe("<$0.01");
    expect(usdShort(0.45678)).toBe("$0.46");
    expect(usdShort(12.5)).toBe("$12.50");
    expect(usdShort(null)).toBe("—");
  });
  it("costLabel in short form keeps the unpriced note and puts the exact amount in the tooltip", () => {
    expect(costLabel(0.00288, 20, 4, true)).toMatchObject({ text: "<$0.01", note: "+4 unpriced" });
    expect(costLabel(0.45678, 5, 0, true)).toEqual({ text: "$0.46", unknown: false, title: "Exactly $0.4568" });
  });
});

describe("providerName", () => {
  it("writes the four providers as their brands", () => {
    expect(["openai", "anthropic", "gemini", "openrouter"].map(providerName)).toEqual(["OpenAI", "Anthropic", "Gemini", "OpenRouter"]);
  });
  it("is not case sensitive and capitalises a provider it does not know", () => {
    expect(providerName("OPENAI")).toBe("OpenAI");
    expect(providerName("mistral")).toBe("Mistral");
    expect(providerName("")).toBe("");
  });
});

describe("costLabel: unknown, free and partly priced are different things", () => {
  it("is unknown when every request has no price", () => {
    expect(costLabel(0, 4, 4)).toMatchObject({ text: "No price yet", unknown: true });
  });
  it("is Free only when the requests were priced at exactly $0", () => {
    expect(costLabel(0, 3, 0)).toMatchObject({ text: "Free", unknown: false });
  });
  it("shows the amount, with how many are missing a price, when only some are", () => {
    expect(costLabel(0.02, 5, 2)).toMatchObject({ text: "$0.0200", note: "+2 unpriced", unknown: false });
  });
  it("shows a plain amount when everything is priced", () => {
    expect(costLabel(1.5, 5, 0)).toEqual({ text: "$1.50", unknown: false });
  });
  it("shows a dash when there are no requests at all", () => {
    expect(costLabel(0, 0, 0).text).toBe("—");
  });
  it("treats a 0 total as unknown (never free) when the API sent no unpriced count", () => {
    expect(costLabel(0, 3)).toMatchObject({ text: "No price yet", unknown: true });
    expect(costLabel(0.5, 3).text).toBe("$0.5000");
  });
});
