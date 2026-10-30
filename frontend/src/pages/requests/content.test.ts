import { describe, expect, it } from "vitest";
import type { RequestContent } from "../../lib/api";
import { promptParts, promptText, responseText } from "./content";

const make = (request: Record<string, unknown>, response = { text: "hi", summary: "" }): RequestContent => ({
  usage_id: 1,
  retention_days: 30,
  content_status: "available",
  content: { v: 1, kind: "chat", request, response },
});

describe("what Copy prompt and Copy response put on the clipboard", () => {
  it("is just the text when there is one part", () => {
    expect(promptText(make({ prompt: "write a haiku" }))).toBe("write a haiku");
  });

  it("labels each part in reading order when there are several", () => {
    const c = make({ system: "be terse", messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] });
    expect(promptParts(c).map((p) => p.label)).toEqual(["system", "user", "assistant"]);
    expect(promptText(c)).toBe("system: be terse\n\nuser: hello\n\nassistant: hi");
  });

  it("joins a list of inputs (an embeddings call) with new lines", () => {
    expect(promptText(make({ input: ["one", "two"] }))).toBe("one\ntwo");
  });

  it("is empty when nothing was stored", () => {
    const none: RequestContent = { usage_id: 1, retention_days: 30, content_status: "expired", content: null };
    expect(promptParts(none)).toEqual([]);
    expect(promptText(none)).toBe("");
    expect(responseText(none)).toBe("");
  });

  it("falls back to the summary when the response has no text (an image or audio call)", () => {
    expect(responseText(make({ prompt: "x" }, { text: "", summary: "1 image generated" }))).toBe("1 image generated");
    expect(responseText(make({ prompt: "x" }))).toBe("hi");
  });
});
