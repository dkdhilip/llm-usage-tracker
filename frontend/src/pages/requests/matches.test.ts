import { describe, expect, it } from "vitest";
import type { GuardrailHit } from "../../lib/api";
import { findRanges, matchedWords, sentenceAround, sentenceForHit } from "./matches";

const hit = (over: Partial<GuardrailHit> = {}): GuardrailHit => ({
  id: 1, ts: "2026-11-01T10:00:00Z", usage_id: 1, request_id: "req-1", key_id: 1, key_label: "support-bot", provider: "openai", model: "m",
  request_status: "blocked", rule_id: 5, rule_name: "Pricing leak", rule_set_name: "Competitor mentions", rule_kind: "phrase", action: "block",
  source_role: "user", occurrences: 1, snippet: "send the [matched] to", matched_text: "price list", snippet_available: true, reviewed: false, ...over,
});

const W = (text: string, inWord = false) => ({ text, inWord });

describe("matchedWords", () => {
  it("takes the matched words of word and phrase hits, once each whatever the case", () => {
    const words = matchedWords([hit({ matched_text: "Price List" }), hit({ id: 2, matched_text: "price list" }), hit({ id: 3, matched_text: "Bluefalcon" })]);
    expect(words.map((w) => w.text)).toEqual(["Price List", "Bluefalcon"]);
  });

  it("ignores a hit that kept no words (a pattern or a detector)", () => {
    expect(matchedWords([hit({ matched_text: null, snippet: "the [matched] plan" }), hit({ matched_text: undefined, snippet: null })])).toEqual([]);
    expect(matchedWords([hit({ matched_text: "   " })])).toEqual([]);
  });

  it("notices when the words sat inside a longer word (so the rule matches inside words)", () => {
    expect(matchedWords([hit({ matched_text: "bomb", snippet: "a [matched]astic remark" })])[0].inWord).toBe(true);
    expect(matchedWords([hit({ matched_text: "bomb", snippet: "pre[matched] x" })])[0].inWord).toBe(true);
    expect(matchedWords([hit({ matched_text: "bomb", snippet: "a [matched] remark" })])[0].inWord).toBe(false);
    expect(matchedWords([hit({ matched_text: "bomb", snippet: "[matched]" })])[0].inWord).toBe(false); // the words are the whole text
  });

  it("looks for the beginning of a phrase that was kept cut short", () => {
    const [w] = matchedWords([hit({ matched_text: "this very long phrase that the server cut…" })]);
    expect(w).toEqual({ text: "this very long phrase that the server cut", inWord: true });
  });
});

describe("findRanges", () => {
  it("finds every occurrence, whatever the case", () => {
    expect(findRanges("Price list, then PRICE LIST again", [W("price list")])).toEqual([[0, 10], [17, 27]]);
  });

  it("lets a line break or extra spaces stand for the space between words", () => {
    expect(findRanges("the price\n list here", [W("price list")])).toEqual([[4, 15]]);
  });

  it("treats the words literally, not as a pattern", () => {
    expect(findRanges("a.b axb a.b", [W("a.b")])).toEqual([[0, 3], [8, 11]]);
    expect(findRanges("(secret) [plan]", [W("(secret)"), W("[plan]")])).toEqual([[0, 8], [9, 15]]);
  });

  it("highlights whole words only, as the rule did, unless the rule was seen matching inside a word", () => {
    expect(findRanges("class ass", [W("ass")])).toEqual([[6, 9]]);
    expect(findRanges("class ass", [W("ass", true)])).toEqual([[2, 5], [6, 9]]);
    expect(findRanges("bombastic bomb", [W("bomb", true)])).toEqual([[0, 4], [10, 14]]);
  });

  it("works with accents and other scripts", () => {
    expect(findRanges("Un café noir, un CAFÉ crème", [W("café")])).toEqual([[3, 7], [17, 21]]);
    expect(findRanges("この機密情報を送って", [W("機密情報", true)])).toEqual([[2, 6]]);
  });

  it("merges words that overlap, and keeps reading order", () => {
    expect(findRanges("send the price list now", [W("price list"), W("price"), W("send")])).toEqual([[0, 4], [9, 19]]);
  });

  it("finds nothing for no words, an empty text, or words that are not there", () => {
    expect(findRanges("anything", [])).toEqual([]);
    expect(findRanges("", [W("x")])).toEqual([]);
    expect(findRanges("nothing here", [W("price list")])).toEqual([]);
    expect(findRanges("anything", [W("   ")])).toEqual([]);
  });

  it("stops at a sensible number of highlights", () => {
    expect(findRanges("x ".repeat(500), [W("x")]).length).toBe(200);
    expect(findRanges("x ".repeat(500), [W("x")], 3).length).toBe(3);
  });
});

describe("sentenceAround", () => {
  const text = "Hi team. Before the call, can you summarise the contract? Also, please send the confidential Price List to the customer. Thanks for the quick turnaround!";
  const at = (needle: string, from = 0): [number, number] => [text.indexOf(needle, from), text.indexOf(needle, from) + needle.length];

  it("is the sentence the words are in, no more", () => {
    expect(sentenceAround(text, at("Price List"))).toEqual({
      before: "Also, please send the confidential ", match: "Price List", after: " to the customer.",
    });
  });

  it("is the first sentence, or the last, when the words are there", () => {
    expect(sentenceAround(text, at("Hi team"))).toEqual({ before: "", match: "Hi team", after: "." });
    expect(sentenceAround(text, at("turnaround"))).toEqual({ before: "Thanks for the quick ", match: "turnaround", after: "!" });
  });

  it("stops at a line break", () => {
    const t = "Line one.\nPlease send the price list now\nLast line";
    const a = t.indexOf("price list");
    expect(sentenceAround(t, [a, a + 10])).toEqual({ before: "Please send the ", match: "price list", after: " now" });
  });

  it("is not fooled by a number with a decimal point", () => {
    const t = "The fee is 3.5 percent of the price list for resellers.";
    const a = t.indexOf("price list");
    expect(sentenceAround(t, [a, a + 10]).before).toBe("The fee is 3.5 percent of the ");
  });

  it("knows where a Chinese or Japanese sentence ends, which has no space after it", () => {
    const t = "こんにちは。この機密情報を送ってください。ありがとう！";
    const a = t.indexOf("機密情報");
    expect(sentenceAround(t, [a, a + 4])).toEqual({ before: "この", match: "機密情報", after: "を送ってください。" });
  });

  it("shows words that run over a line break as one line", () => {
    const t = "Please attach the price\nlist today";
    expect(sentenceAround(t, [0, t.length])).toEqual({ before: "", match: "Please attach the price list today", after: "" });
  });

  it("cuts a very long sentence at a word, with an ellipsis, and keeps the words in it", () => {
    const long = "word ".repeat(100) + "TARGET" + " word".repeat(100);
    const a = long.indexOf("TARGET");
    const s = sentenceAround(long, [a, a + 6]);
    expect(s.match).toBe("TARGET");
    expect(s.before.startsWith("…word ")).toBe(true);
    expect(s.after.endsWith("word…")).toBe(true);
    expect(s.before.length).toBeLessThan(125);
    expect(s.after.length).toBeLessThan(125);
  });

  it("copes with a text that is one long word", () => {
    const long = "a".repeat(400) + "TARGET" + "b".repeat(400);
    const s = sentenceAround(long, [400, 406]);
    expect(s.match).toBe("TARGET");
    expect(s.before.length).toBeLessThan(125);
    expect(s.after.length).toBeLessThan(125);
  });
});

describe("sentenceForHit", () => {
  const parts = [
    { label: "system", text: "You are a helpful assistant." },
    { label: "user", text: "Hello. Please send the Price List to the customer." },
  ];

  it("cuts the sentence out of the stored prompt", () => {
    expect(sentenceForHit(hit(), parts)).toEqual({ before: "Please send the ", match: "Price List", after: " to the customer." });
  });

  it("looks in the part the rule found it in first", () => {
    const two = [{ label: "assistant", text: "Our price list is attached." }, { label: "user", text: "Please send the price list today." }];
    expect(sentenceForHit(hit({ source_role: "user" }), two)?.before).toBe("Please send the ");
    expect(sentenceForHit(hit({ source_role: "assistant" }), two)?.before).toBe("Our ");
  });

  it("gives nothing when the hit kept no words, or the prompt does not hold them", () => {
    expect(sentenceForHit(hit({ matched_text: null }), parts)).toBeNull();
    expect(sentenceForHit(hit({ matched_text: "secret plan" }), parts)).toBeNull();
    expect(sentenceForHit(hit(), [])).toBeNull();
  });
});
