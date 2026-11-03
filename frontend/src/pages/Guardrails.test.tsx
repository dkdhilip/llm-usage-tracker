import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { api, type GuardrailRuleSet, type GuardrailRuleSets, type KeyRow } from "../lib/api";
import { chooseKeyAction, keyRow } from "../test/workspaceHelpers";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isWorkspaceAdmin: true, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      getWorkspace: vi.fn(), listKeys: vi.fn(), getAccount: vi.fn(), integrationGuide: vi.fn(), updateKey: vi.fn(), createKey: vi.fn(),
      guardrails: {
        ruleSets: vi.fn(), presets: vi.fn(), status: vi.fn(), activity: vi.fn(), createSet: vi.fn(), updateSet: vi.fn(), deleteSet: vi.fn(),
        createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), setKeyRuleSets: vi.fn(), test: vi.fn(),
      },
    },
  };
});

const g = vi.mocked(api.guardrails);

const key = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: 1, label: "support-bot", key_prefix: "vk_abcdefgh", assigned_username: null, allowed_providers: ["openai"], allow_live: true,
  default_provider: null, monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null, expires_at: null,
  spend_period: 0, created_at: "2026-10-01T00:00:00Z", last_used_at: null, revoked_at: null, requests: 3, total_tokens: 0, cost: 0.1,
  guardrail_rule_set_ids: [], ...over,
});

const set = (over: Partial<GuardrailRuleSet> = {}): GuardrailRuleSet => ({ id: 7, name: "No secrets", description: null, enabled: true, rules: [], key_ids: [], ...over });
const rule = { id: 70, name: "Codename", kind: "phrase" as const, pattern: "bluefalcon", preset_id: null, action: "block" as const, whole_word: false, enabled: true, position: 0 };

const sets = (items: GuardrailRuleSet[], enabled = true): GuardrailRuleSets => ({
  enabled,
  limits: { pattern_chars: 200, rules_per_set: 50, sets_per_key: 5, rules_per_key: 100, sets_per_workspace: 20 },
  items,
});

function open(url = "/workspace?tab=guardrails") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Workspace />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.getWorkspace).mockResolvedValue({
    id: 1, name: "Acme", role: "admin", members: [{ user_id: 1, username: "admin", role: "admin", assigned_keys: 0, requests: 0, cost: 0 }], invites: [],
    providers: [{ provider: "openai", configured: true, source: "workspace", last4: "1234", monthly_cap_usd: null, spend_this_month: 0 }],
  } as never);
  vi.mocked(api.getAccount).mockResolvedValue({ live_cap_default_usd: 5 } as never);
  vi.mocked(api.listKeys).mockResolvedValue([key()]);
  vi.mocked(api.updateKey).mockResolvedValue({});
  vi.mocked(api.integrationGuide).mockResolvedValue({ target: "hosted", gateway_url: "", targets: { hosted: "", local: "" }, general_notes: [], providers: [] } as never);
  g.ruleSets.mockResolvedValue(sets([]));
  g.presets.mockResolvedValue([{ id: "card", label: "Payment card numbers", description: "13-19 digit numbers that pass the Luhn check." }]);
  g.status.mockResolvedValue({ enabled: true, last_24h: { blocked: 0, flagged: 0, unchecked: 0 }, recording: { ceiling_per_hour: 1000, throttled_at: null }, evidence_gaps: [], retention_days: 30 });
  g.activity.mockResolvedValue({ items: [], next_cursor: null });
});

describe("Guardrails tab", () => {
  it("explains what to do first, and warns while enforcement is off", async () => {
    g.ruleSets.mockResolvedValue(sets([], false));
    open();
    expect(await screen.findByText("No content rules yet")).toBeInTheDocument();
    expect(screen.getByText("Content rules are not being enforced yet")).toBeInTheDocument();
    expect(screen.getByText(/policy aid, not a security boundary/i)).toBeInTheDocument();
  });

  it("creates a rule set", async () => {
    const user = userEvent.setup();
    g.createSet.mockResolvedValue(set());
    open();
    await user.click((await screen.findAllByRole("button", { name: /New rule set/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New rule set" });
    expect(within(dialog).getByRole("button", { name: "Create rule set" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), "No secrets");
    await user.click(within(dialog).getByRole("button", { name: "Create rule set" }));
    await waitFor(() => expect(g.createSet).toHaveBeenCalledWith({ name: "No secrets", description: null }));
  });

  it("asks for consent before the very first rule, then saves it as Flag by default", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set()]));
    g.createRule.mockResolvedValue(rule);
    open();
    await user.click(await screen.findByRole("button", { name: /Add rule to No secrets/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
    await user.type(within(dialog).getByLabelText("Rule name"), "Codename");
    await user.type(within(dialog).getByLabelText("Word or phrase"), "bluefalcon");
    expect(within(dialog).getByRole("radio", { name: /Flag/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    const consent = await screen.findByRole("alertdialog");
    expect(within(consent).getByText(/never the matched text itself/)).toBeInTheDocument();
    expect(g.createRule).not.toHaveBeenCalled();
    await user.click(within(consent).getByRole("button", { name: "I understand" }));
    await waitFor(() =>
      expect(g.createRule).toHaveBeenCalledWith(7, { name: "Codename", kind: "phrase", pattern: "bluefalcon", preset_id: null, action: "flag", whole_word: false }),
    );
  });

  it("does not add the rule if the consent is cancelled", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set()]));
    open();
    await user.click(await screen.findByRole("button", { name: /Add rule to No secrets/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
    await user.type(within(dialog).getByLabelText("Rule name"), "x");
    await user.type(within(dialog).getByLabelText("Word or phrase"), "y");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(g.createRule).not.toHaveBeenCalled();
    expect(await within(await screen.findByRole("dialog", { name: "Add a rule" })).findByText(/no rule was added/i)).toBeInTheDocument();
  });

  it("shows the reason when the server refuses a pattern, and keeps the dialog open", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule] })])); // not the first rule: no consent step
    g.createRule.mockRejectedValue(new Error("pattern has no visible characters"));
    open();
    await user.click(await screen.findByRole("button", { name: /Add rule to No secrets/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
    await user.type(within(dialog).getByLabelText("Rule name"), "blank");
    await user.type(within(dialog).getByLabelText("Word or phrase"), "\u200b");
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    expect(await within(dialog).findByText(/no visible characters/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("What to look for")).not.toBeInTheDocument(); // words only: no pattern option
  });

  it("tries a rule on sample text without saving anything", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set()]));
    g.test.mockResolvedValue({ matched: true, occurrences: 2, snippet: "the [matched] plan", unchecked: false });
    open();
    await user.click(await screen.findByRole("button", { name: /Add rule to No secrets/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
    await user.type(within(dialog).getByLabelText("Rule name"), "n");
    await user.type(within(dialog).getByLabelText("Word or phrase"), "bluefalcon");
    expect(within(dialog).getByRole("button", { name: "Try it" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Try it"), "the bluefalcon plan");
    await user.click(within(dialog).getByRole("button", { name: "Try it" }));
    expect(await within(dialog).findByText(/Matches/)).toBeInTheDocument();
    expect(within(dialog).getByText(/the \[matched\] plan/)).toBeInTheDocument();
    expect(g.createRule).not.toHaveBeenCalled();
    expect(g.test).toHaveBeenCalledWith({ kind: "phrase", pattern: "bluefalcon", preset_id: null, whole_word: false, text: "the bluefalcon plan" });
  });

  it("lists rules with their action as text, and toggles a rule off", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule], key_ids: [1] })]));
    g.updateRule.mockResolvedValue({ ...rule, enabled: false });
    open();
    const article = await screen.findByRole("article", { name: "Rule set No secrets" });
    expect(within(article).getByText("Block")).toBeInTheDocument();
    expect(within(article).getByText("bluefalcon")).toBeInTheDocument();
    expect(within(article).getByText(/Used by support-bot/)).toBeInTheDocument();
    await user.click(within(article).getByRole("button", { name: /Disable Codename/ }));
    await waitFor(() => expect(g.updateRule).toHaveBeenCalledWith(70, { enabled: false }));
  });

  it("has no built-in detectors section, and still shows a detector rule saved earlier (it is still enforced)", async () => {
    const user = userEvent.setup();
    const card = { ...rule, id: 71, name: "Payment card numbers", kind: "preset" as const, pattern: null, preset_id: "card", action: "flag" as const };
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule, card] })]));
    g.deleteRule.mockResolvedValue({ id: 71 });
    open();
    const list = await screen.findByRole("list", { name: "Rules in No secrets" });
    expect(screen.queryByRole("button", { name: /Built-in detectors/ })).not.toBeInTheDocument();
    const row = within(list).getAllByRole("listitem")[1];
    expect(within(row).getAllByText("Payment card numbers").length).toBeGreaterThan(0);
    expect(within(row).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument(); // nothing to edit for a detector
    expect(within(row).getByRole("button", { name: /Disable Payment card numbers/ })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Delete Payment card numbers/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete rule" }));
    await waitFor(() => expect(g.deleteRule).toHaveBeenCalledWith(71));
  });

  it("confirms before deleting a rule set", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule], key_ids: [1] })]));
    g.deleteSet.mockResolvedValue({ id: 7 });
    open();
    await user.click(await screen.findByRole("button", { name: /Delete No secrets/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/stops applying to 1 key/)).toBeInTheDocument();
    expect(g.deleteSet).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Delete rule set" }));
    await waitFor(() => expect(g.deleteSet).toHaveBeenCalledWith(7));
  });

  it("warns when matches could not be recorded, in words", async () => {
    g.status.mockResolvedValue({
      enabled: true, last_24h: { blocked: 3, flagged: 1, unchecked: 2 }, retention_days: 30,
      recording: { ceiling_per_hour: 1000, throttled_at: "2026-11-02T10:00:00Z" }, evidence_gaps: [{ ts: "2026-11-02T10:00:00Z", count: 4 }],
    });
    g.ruleSets.mockResolvedValue(sets([set()]));
    open();
    expect(await screen.findByText("Matches were not all recorded")).toBeInTheDocument();
    expect(screen.getByText(/4 recent matches/)).toBeInTheDocument();
    expect(screen.getByText(/3 blocked, 1 flagged, 2 not fully checked/)).toBeInTheDocument();
  });

  it("shows the activity list on demand", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set()]));
    g.activity.mockResolvedValue({ items: [{ id: 1, ts: "2026-11-02T10:00:00Z", actor_user_id: 1, action: "rule.create", target_type: "rule", target_id: "70", detail: { name: "Codename" } }], next_cursor: null });
    open();
    await user.click(await screen.findByRole("button", { name: /Show recent changes/ }));
    expect(await screen.findByText("Added a rule")).toBeInTheDocument();
    expect(screen.getByText("Codename")).toBeInTheDocument();
  });
});

describe("Content rules on keys", () => {
  it("shows nothing about rules on a keys page until a rule set exists", async () => {
    open("/workspace");
    await screen.findByText("support-bot");
    expect(screen.queryByTestId("key-rules-1")).not.toBeInTheDocument();
  });

  it("attaches a rule set from the key's menu and shows it as a badge", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule] })]));
    g.setKeyRuleSets.mockResolvedValue({ key_id: 1, rule_set_ids: [7] });
    open("/workspace");
    await screen.findByText("support-bot");
    await chooseKeyAction(user, "support-bot", "Content rules");
    const editor = await screen.findByTestId("key-rules-editor-1");
    await user.click(within(editor).getByRole("checkbox", { name: /No secrets/ }));
    await waitFor(() => expect(g.setKeyRuleSets).toHaveBeenCalledWith(1, [7]));
  });

  it("shows an attached set on the key row, marked inactive while enforcement is off", async () => {
    g.ruleSets.mockResolvedValue(sets([set()], false));
    vi.mocked(api.listKeys).mockResolvedValue([key({ guardrail_rule_set_ids: [7] })]);
    open("/workspace");
    await screen.findByText("support-bot");
    const cell = await screen.findByTestId("key-rules-1");
    expect(within(keyRow("support-bot")).getByTestId("key-rules-1")).toBe(cell);
    expect(cell).toHaveTextContent("Rules: No secrets (inactive)");
  });

  it("sends the chosen rule sets when a key is created", async () => {
    const user = userEvent.setup();
    g.ruleSets.mockResolvedValue(sets([set({ rules: [rule] })]));
    vi.mocked(api.createKey).mockResolvedValue({
      id: 9, label: "new-key", key: "vk_SECRET", key_prefix: "vk_new", allowed_providers: ["openai"], allow_live: true, default_provider: "openai",
      monthly_budget_usd: null, budget_period: "month", budget_start: null, budget_end: null, expires_at: null, created_at: "2026-11-02T00:00:00Z",
    } as never);
    open("/workspace");
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const drawer = await screen.findByRole("dialog", { name: "Create a virtual key" });
    await user.type(within(drawer).getByLabelText("Key label"), "new-key");
    await user.click(within(drawer).getByRole("checkbox", { name: /No secrets/ }));
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(api.createKey).toHaveBeenCalled());
    expect(vi.mocked(api.createKey).mock.calls[0][0]).toMatchObject({ label: "new-key", guardrail_rule_set_ids: [7] });
  });
});
