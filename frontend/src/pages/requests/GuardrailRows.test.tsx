import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type GuardrailHit, type RequestRow } from "../../lib/api";
import { GuardrailSection } from "./GuardrailSection";
import { StoredContentSections } from "./content";
import { RequestFilters } from "./RequestFilters";
import { RequestList } from "./RequestList";

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

  it("has a Content rules filter that goes into the URL", () => {
    const set = vi.fn();
    render(<RequestFilters get={(k) => (k === "guardrail" ? "flagged" : "")} set={set} keys={[]} models={[]} hasFilters onClear={() => {}} />);
    const select = screen.getByLabelText("Content rules") as HTMLSelectElement;
    expect(select.value).toBe("flagged");
    expect([...select.options].map((o) => o.text)).toEqual(["All", "Matched a rule", "Blocked by a rule", "Flagged by a rule", "Not fully checked"]);
  });
});

describe("the inspector's Content rules section", () => {
  it("shows nothing for an ordinary request", () => {
    const { container } = render(<GuardrailSection row={row()} />);
    expect(container).toBeEmptyDOMElement();
    expect(g.hitItems).not.toHaveBeenCalled();
  });

  it("explains a blocked request and shows the redacted context of each match", async () => {
    g.hitItems.mockResolvedValue({ items: [hit()], retention_days: 30 });
    render(<GuardrailSection row={row({ status: "blocked", guardrail: "blocked" })} />);
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
    render(<GuardrailSection row={row({ status: "blocked", guardrail: "blocked" })} />);
    const mark = await screen.findByText("Blue Falcon");
    expect(mark.tagName).toBe("MARK");
    expect(mark.parentElement).toHaveTextContent("tell me the Blue Falcon plan");
    expect(mark.parentElement).not.toHaveTextContent("[matched]");
  });

  it("says why there is no context when none was kept", async () => {
    g.hitItems.mockResolvedValue({ items: [hit({ snippet: null, snippet_available: false })], retention_days: 30 });
    render(<GuardrailSection row={row({ guardrail: "flagged" })} />);
    expect(await screen.findByText(/Context isn't shown for this match/)).toBeInTheDocument();
  });

  it("says when the details are gone", async () => {
    g.hitItems.mockResolvedValue({ items: [], retention_days: 30 });
    render(<GuardrailSection row={row({ guardrail: "flagged" })} />);
    expect(await screen.findByText(/no longer available \(they are deleted after 30 days\)/)).toBeInTheDocument();
  });

  it("explains 'not fully checked' without fetching matches", () => {
    render(<GuardrailSection row={row({ guardrail: "unchecked" })} />);
    expect(screen.getByTestId("guardrail-explain")).toHaveTextContent(/went through without being fully checked/);
    expect(g.hitItems).not.toHaveBeenCalled();
  });

  it("reports a failed load in words", async () => {
    g.hitItems.mockRejectedValue(new Error("database unavailable"));
    render(<GuardrailSection row={row({ guardrail: "blocked" })} />);
    expect(await screen.findByText(/Couldn't load the matches: database unavailable/)).toBeInTheDocument();
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
});
