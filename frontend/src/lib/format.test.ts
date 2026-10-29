import { describe, expect, it } from "vitest";
import { costLabel, providerName } from "./format";

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
