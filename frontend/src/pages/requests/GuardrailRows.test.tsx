import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type GuardrailHit, type RequestContent, type RequestRow } from "../../lib/api";
import { GuardrailSection } from "./GuardrailSection";
import { StoredContentSections } from "./content";
import { matchedWords } from "./matches";
import { RequestFilters } from "./RequestFilters";
import { RequestList } from "./RequestList";
import { useGuardrailHits } from "./useGuardrailHits";

vi.mock("../../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/api")>();
  return { ...real, api: { guardrails: { hitItems: vi.fn() } } };
});

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 1, ts: "2026-11-01T10:00:00Z", request_id: "req-1", key_id: 1, key_label: "support-bot", key_prefix: "vk_x", provider: "openai",
  model: "gpt-4o-mini", prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, cost: 0.001, cost_source: "configured", latency_ms: 120,
  status: "success", prompt_preview: null, response_preview: null, guardrail: null, guardrail_rules: [], ...over,
});

const hit = (over: Partial<GuardrailHit> = {}): GuardrailHit => ({
  id: 1, ts: "2026-11-01T10:00:00Z", usage_id: 1, request_id: "req-1", key_id: 1, key_label: "support-bot", provider: "openai", model: "m",
  request_status: "blocked", rule_id: 5, rule_name: "Codename", rule_set_name: "No secrets", rule_kind: "phrase", action: "block", source_role: "user",
  occurrences: 2, snippet: "tell me the [matched] plan", snippet_available: true, reviewed: false, ...over,
});

/** The stored prompt of a request, as the inspector receives it. */
const promptOf = (...messages: { role: string; text: string }[]): RequestContent => ({
  usage_id: 1, retention_days: 30, content_status: "available",
  content: { v: 1, kind: "chat", request: { messages }, response: { text: "", summary: "" } },
  request_truncated: false, response_truncated: false, images: [],
});

/** The inspector's Content rules card with its hits loaded the way the inspector loads them. */
function WithHits({ row: r, content, contentError }: { row: RequestRow; content?: RequestContent | null; contentError?: string | null }) {
  const hits = useGuardrailHits(r);
  return <GuardrailSection row={r} hits={hits} content={content} contentError={contentError} />;
}

function list(rows: RequestRow[], phone = false) {
  return render(
    <MemoryRouter>
      <RequestList rows={rows} selectedId={null} phone={phone} showTokens constrain={false} loading={false} error={false} hasFilters={false} more={false} onOpen={() => {}} onLoadMore={() => {}} />
    </MemoryRouter>,
  );
}

const g = vi.mocked(api.guardrails);
beforeEach(() => vi.clearAllMocks());

describe("requests a content rule matched", () => {
  const rows = [
    row({ id: 1, status: "blocked", guardrail: "blocked", guardrail_rules: [{ rule_name: "Card numbers", action: "block" }] }),
    row({ id: 2, guardrail: "flagged", guardrail_rules: [{ rule_name: "Codename", action: "flag" }, { rule_name: "Email", action: "flag" }, { rule_name: "Keys", action: "flag" }] }),
    row({ id: 3, guardrail: "unchecked" }),
    row({ id: 4 }),
  ];

  it("tints blocked and flagged rows only, and says why in words", () => {
    list(rows);
    const tinted = (id: number) => document.querySelector(`[data-request-row="${id}"]`)!.getAttribute("data-rule-row");
    expect(tinted(1)).toBe("blocked");
    expect(tinted(2)).toBe("flagged");
    expect(tinted(3)).toBeNull(); // not fully checked is a notice, not an alarm
    expect(tinted(4)).toBeNull();
    const r1 = document.querySelector('[data-request-row="1"]') as HTMLElement;
    expect(within(r1).getByText("Blocked")).toBeInTheDocument();
    expect(within(r1).getByText("Rule: Card numbers")).toBeInTheDocument();
    const r2 = document.querySelector('[data-request-row="2"]') as HTMLElement;
    expect(within(r2).getByText("Flagged: Codename, Email +1")).toBeInTheDocument();
    expect(within(document.querySelector('[data-request-row="3"]') as HTMLElement).getByText("Not fully checked")).toBeInTheDocument();
    expect(within(document.querySelector('[data-request-row="4"]') as HTMLElement).queryByText(/Flagged|Rule:|checked/)).not.toBeInTheDocument();
  });

  it("does the same on a phone", () => {
    list(rows, true);
    expect(screen.getByText("Rule: Card numbers")).toBeInTheDocument();
    expect(screen.getByText("Flagged: Codename, Email +1")).toBeInTheDocument();
    expect(screen.getByText("Not fully checked")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-rule-row]").length).toBe(2);
  });

  it("has a Content rules filter that goes into the URL", async () => {
    const set = vi.fn();
    render(<RequestFilters get={(k) => (k === "guardrail" ? "flagged" : "")} set={set} keys={[]} models={[]} hasFilters onClear={() => {}} />);
    const box = screen.getByRole("combobox", { name: "Content rules: Flagged by a rule" }); // the current choice is on the control
    await userEvent.click(box);
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["All requests", "Matched a rule", "Blocked by a rule", "Flagged by a rule", "Not fully checked"]);
    await userEvent.click(screen.getByRole("option", { name: "Blocked by a rule" }));
    expect(set).toHaveBeenCalledWith("guardrail", "blocked");
  });
});

describe("the inspector's Content rules section", () => {
  it("shows nothing for an ordinary request", () => {
    const { container } = render(<WithHits row={row()} />);
    expect(container).toBeEmptyDOMElement();
    expect(g.hitItems).not.toHaveBeenCalled();
  });

  it("explains a blocked request and shows the redacted context of each match", async () => {
    g.hitItems.mockResolvedValue({ items: [hit()], retention_days: 30 });
    render(<WithHits row={row({ status: "blocked", guardrail: "blocked" })} />);
    expect(screen.getByTestId("guardrail-explain")).toHaveTextContent(/stopped this request before it reached the provider/);
    expect(await screen.findByText("tell me the [matched] plan")).toBeInTheDocument();
    expect(screen.getByText("Codename")).toBeInTheDocument();
    expect(screen.getByText("Block")).toBeInTheDocument();
    expect(screen.getByText(/2 matches · in the user text/)).toBeInTheDocument();
    expect(screen.getByText(/prompt of a flagged or blocked request is kept/)).toBeInTheDocument();
    expect(g.hitItems).toHaveBeenCalledWith(1);
  });

  it("highlights the matched words inside their context when the server kept them", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ matched_text: "Blue Falcon" })], retention_days: 30 });
    render(<WithHits row={row({ status: "blocked", guardrail: "blocked" })} />);
    const mark = await screen.findByText("Blue Falcon");
    expect(mark.tagName).toBe("MARK");
    expect(mark.parentElement).toHaveTextContent("tell me the Blue Falcon plan");
    expect(mark.parentElement).not.toHaveTextContent("[matched]");
  });

  it("says why there is no context when none was kept", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ snippet: null, snippet_available: false })], retention_days: 30 });
    render(<WithHits row={row({ guardrail: "flagged" })} />);
    expect(await screen.findByText(/Context isn't shown for this match/)).toBeInTheDocument();
  });

  it("says when the details are gone", async () => {
    g.hitItems.mockResolvedValue({ items: [], retention_days: 30 });
    render(<WithHits row={row({ guardrail: "flagged" })} />);
    expect(await screen.findByText(/no longer available \(they are deleted after 30 days\)/)).toBeInTheDocument();
  });

  it("explains 'not fully checked' without fetching matches", () => {
    render(<WithHits row={row({ guardrail: "unchecked" })} />);
    expect(screen.getByTestId("guardrail-explain")).toHaveTextContent(/went through without being fully checked/);
    expect(g.hitItems).not.toHaveBeenCalled();
  });

  it("reports a failed load in words", async () => {
    g.hitItems.mockRejectedValue(new Error("database unavailable"));
    render(<WithHits row={row({ guardrail: "blocked" })} />);
    expect(await screen.findByText(/Couldn't load the matches: database unavailable/)).toBeInTheDocument();
  });

  it("does not show one request's matches while the next request's are loading", async () => {
    g.hitItems.mockResolvedValueOnce({ items: [hit({ matched_text: "Blue Falcon" })], retention_days: 30 });
    const { rerender } = render(<WithHits row={row({ id: 1, guardrail: "blocked" })} />);
    expect(await screen.findByText("Blue Falcon")).toBeInTheDocument();
    g.hitItems.mockReturnValueOnce(new Promise(() => {})); // the next request's answer has not come yet
    rerender(<WithHits row={row({ id: 2, guardrail: "blocked" })} />);
    expect(screen.queryByText("Blue Falcon")).not.toBeInTheDocument();
    expect(screen.getByText("Loading matches…")).toBeInTheDocument();
  });
});

describe("the sentence a rule matched in", () => {
  const SAID = "Hi team. Before the call, can you summarise the contract? Also, please send the confidential Price List to the customer. Thanks for the quick turnaround!";
  const blockedRow = (over: Partial<RequestRow> = {}) => row({ status: "blocked", guardrail: "blocked", has_content: true, ...over });
  const pricing = (over: Partial<GuardrailHit> = {}) =>
    hit({ rule_name: "Pricing leak", matched_text: "Price List", snippet: "d the confidential [matched] to the customer. Th", ...over });

  it("shows the whole sentence with the matched words highlighted, not a cut-off fragment", async () => {
    g.hitItems.mockResolvedValue({ items: [pricing()], retention_days: 30 });
    render(<WithHits row={blockedRow()} content={promptOf({ role: "user", text: SAID })} />);
    const quote = await screen.findByTestId("matched-sentence");
    expect(quote).toHaveTextContent("Also, please send the confidential Price List to the customer.");
    expect(quote).not.toHaveTextContent("Before the call");
    expect(quote).not.toHaveTextContent("Thanks for the quick");
    const mark = within(quote).getByText("Price List");
    expect(mark.tagName).toBe("MARK");
    expect(screen.queryByText(/customer\. Th/)).not.toBeInTheDocument(); // the cut-off excerpt ("... customer. Th") is not shown as well
  });

  it("finds the words whatever their case, and across a line break", async () => {
    g.hitItems.mockResolvedValue({ items: [pricing({ matched_text: "price list" })] , retention_days: 30 });
    render(<WithHits row={blockedRow()} content={promptOf({ role: "user", text: "Ok.\nPlease attach the PRICE\nLIST today." })} />);
    const quote = await screen.findByTestId("matched-sentence");
    expect(quote).toHaveTextContent("Please attach the PRICE LIST today.");
    expect(within(quote).getByText("PRICE LIST").tagName).toBe("MARK");
  });

  it("falls back to the short context the server kept when the prompt does not hold the words", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ matched_text: "Blue Falcon" })], retention_days: 30 });
    render(<WithHits row={blockedRow()} content={promptOf({ role: "user", text: "something else entirely" })} />);
    const mark = await screen.findByText("Blue Falcon");
    expect(mark.tagName).toBe("MARK");
    expect(mark.parentElement).toHaveTextContent("tell me the Blue Falcon plan");
    expect(screen.queryByTestId("matched-sentence")).not.toBeInTheDocument();
  });

  it("falls back to it when the prompt could not be loaded", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ matched_text: "Blue Falcon" })], retention_days: 30 });
    render(<WithHits row={blockedRow()} content={null} contentError="Stored content can no longer be decrypted." />);
    expect((await screen.findByText("Blue Falcon")).parentElement).toHaveTextContent("tell me the Blue Falcon plan");
  });

  it("waits for the prompt rather than show a short excerpt that is then replaced", async () => {
    g.hitItems.mockResolvedValue({ items: [pricing()], retention_days: 30 });
    const r = blockedRow();
    const { rerender } = render(<WithHits row={r} content={null} />);
    await waitFor(() => expect(g.hitItems).toHaveBeenCalled());
    expect(screen.getByText("Loading matches…")).toBeInTheDocument();
    expect(screen.queryByText("Pricing leak")).not.toBeInTheDocument();
    rerender(<WithHits row={r} content={promptOf({ role: "user", text: SAID })} />);
    expect(await screen.findByTestId("matched-sentence")).toBeInTheDocument();
  });

  it("keeps showing [matched] for a pattern rule, which keeps no words", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ rule_kind: "regex", matched_text: null, snippet: "my id is [matched] ok" })], retention_days: 30 });
    render(<WithHits row={blockedRow()} content={promptOf({ role: "user", text: "my id is 123-45-6789 ok" })} />);
    expect(await screen.findByText("my id is [matched] ok")).toBeInTheDocument();
    expect(screen.queryByTestId("matched-sentence")).not.toBeInTheDocument();
  });
});

describe("the prompt kept for a flagged or blocked request", () => {
  const content = (response = { text: "", summary: "" }) => ({
    usage_id: 1, retention_days: 30, content_status: "available" as const, content: { v: 1, kind: "chat", request: { messages: [{ role: "user", text: "the launch codename is bluefalcon" }] }, response },
    request_truncated: false, response_truncated: false, images: [],
  });

  it("shows the exact prompt, and no empty Response box for a blocked request (it never reached the provider)", () => {
    render(<StoredContentSections content={content()} error={null} usageId={1} requestOnly />);
    expect(screen.getByRole("region", { name: "Prompt: user" })).toHaveTextContent("the launch codename is bluefalcon");
    expect(screen.queryByRole("heading", { name: "Response" })).not.toBeInTheDocument();
  });

  it("says so when a flagged request that went through has no stored response (logging is off)", () => {
    render(<StoredContentSections content={content()} error={null} usageId={1} />);
    expect(screen.getByRole("region", { name: "Prompt: user" })).toBeInTheDocument();
    expect(screen.getByText(/No response was stored/)).toBeInTheDocument();
  });

  it("still shows the Response section for a flagged request that went through", () => {
    render(<StoredContentSections content={content({ text: "ok", summary: "" })} error={null} usageId={1} />);
    expect(screen.getByRole("region", { name: "Prompt: user" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Response" })).toBeInTheDocument();
  });

  describe("with the matched words highlighted", () => {
    const words = matchedWords([hit({ matched_text: "Bluefalcon" })]);
    const flagged = promptOf(
      { role: "system", text: "You are a helpful assistant." },
      { role: "user", text: "Quick question.\n\nWhat is the status of the Bluefalcon launch?\nAlso, is BLUEFALCON ready for the demo?" },
    );

    it("highlights every occurrence in the prompt, whatever the case, and says what the highlight means", () => {
      render(<StoredContentSections content={flagged} error={null} usageId={1} requestOnly words={words} />);
      const box = screen.getByRole("region", { name: "Prompt: user" });
      const marks = within(box).getAllByText(/bluefalcon/i);
      expect(marks.map((m) => [m.tagName, m.textContent])).toEqual([["MARK", "Bluefalcon"], ["MARK", "BLUEFALCON"]]);
      expect(box).toHaveTextContent("What is the status of the Bluefalcon launch?");
      expect(screen.getByText("The words a content rule matched are highlighted.")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Prompt: system" }).querySelector("mark")).toBeNull(); // not in the system prompt
    });

    it("keeps the prompt exactly as it was written (the copy button and the text are unchanged)", () => {
      render(<StoredContentSections content={flagged} error={null} usageId={1} requestOnly words={words} />);
      const box = screen.getByRole("region", { name: "Prompt: user" });
      expect(box.textContent).toBe("Quick question.\n\nWhat is the status of the Bluefalcon launch?\nAlso, is BLUEFALCON ready for the demo?");
    });

    it("highlights nothing, and says nothing, when no words were matched or none is in the prompt", () => {
      const { rerender } = render(<StoredContentSections content={flagged} error={null} usageId={1} requestOnly words={[]} />);
      expect(document.querySelector("mark")).toBeNull();
      expect(screen.queryByText(/are highlighted/)).not.toBeInTheDocument();
      rerender(<StoredContentSections content={flagged} error={null} usageId={1} requestOnly words={[{ text: "price list", inWord: false }]} />);
      expect(document.querySelector("mark")).toBeNull();
      expect(screen.queryByText(/are highlighted/)).not.toBeInTheDocument();
    });

    it("highlights only whole words when the rule matches whole words", () => {
      const c = promptOf({ role: "user", text: "A class of its own, and an ass." });
      render(<StoredContentSections content={c} error={null} usageId={1} requestOnly words={[{ text: "ass", inWord: false }]} />);
      expect(screen.getAllByText("ass", { selector: "mark" })).toHaveLength(1);
      expect(screen.getByRole("region", { name: "Prompt: user" })).toHaveTextContent("A class of its own, and an ass.");
    });
  });
});
