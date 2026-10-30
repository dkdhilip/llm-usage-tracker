// Creates the fake accounts, workspace, keys and a few stored requests for the UI audit (local app only).
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.UI_AUDIT_BASE || `http://127.0.0.1:${process.env.PORT || 8765}`;
const OUT = process.argv[2];
const browser = await chromium.launch({ channel: process.env.UI_AUDIT_BROWSER || "chrome", headless: true });

async function actor(username) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByText("New here? Create an account").click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("pw-abcdefgh-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL(/welcome/);
  const call = (method, path, body) =>
    page.evaluate(async ([method, path, body]) => {
      const csrf = (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || "";
      const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
      return { s: r.status, j: await r.json().catch(() => null) };
    }, [method, path, body]);
  return { ctx, page, call };
}

const creds = { password: "pw-abcdefgh-1", users: {}, keys: {} };

// the admin of the main workspace
const admin = await actor("auditadmin");
creds.users.admin = "auditadmin";
await admin.call("POST", "/api/workspace", { name: "Acme AI Platform" });
for (const p of ["openai", "anthropic", "gemini", "openrouter"]) await admin.call("PUT", `/api/workspace/providers/${p}/key`, { api_key: `fake-${p}-key-0123456789abcdef` });

// a team member who joins and gets one key
const inv = await admin.call("POST", "/api/workspace/invites", { label: "samuel" });
const member = await actor("samuel");
creds.users.member = "samuel";
await member.call("POST", "/api/workspace/join", { code: inv.j.code });
const samId = (await member.call("GET", "/api/auth/me")).j.user.id;
await admin.call("POST", "/api/workspace/invites", { label: "design-team" }); // a pending invite

const mk = async (label, providers, extra = {}) => {
  const r = await admin.call("POST", "/api/keys", { label, allowed_providers: providers, allow_live: true, ...extra });
  creds.keys[label] = { id: r.j.id, raw: r.j.key };
};
await mk("prod-openai", ["openai"], { monthly_budget_usd: 50, budget_period: "month" });
await mk("sam-anthropic", ["anthropic"], { assigned_user_id: samId, monthly_budget_usd: 20, budget_period: "month" });
await mk("dhilip-gemini", ["gemini"]);
await mk("dhilip-openrouter", ["openrouter"], { monthly_budget_usd: 5, budget_period: "week" });
await mk("support-bot", ["openai", "anthropic"], { default_provider: "openai", monthly_budget_usd: 200, budget_period: "month" });
await mk("marketing-analytics-batch-eu-west", ["anthropic"]);
await mk("old-key", ["openai"]);
await mk("mod-key", ["openai"]);
await mk("mixed-key", ["openai"]);
await mk("gone-key", ["openai"]);
await admin.call("DELETE", `/api/keys/${creds.keys["old-key"].id}`);
await admin.call("DELETE", `/api/keys/${creds.keys["gone-key"].id}`);
await admin.call("POST", `/api/keys/${creds.keys["gone-key"].id}/delete`);

// prompt/response (and image) logging on, for two keys, then a few real gateway calls (providers are mocked)
await admin.call("PATCH", "/api/workspace/content-logging", { enabled: true });
await admin.call("PATCH", "/api/workspace/image-logging", { enabled: true });
for (const l of ["prod-openai", "support-bot"]) await admin.call("PATCH", `/api/keys/${creds.keys[l].id}`, { content_logging_enabled: true, image_logging_enabled: true });
const prompts = [
  "Summarise the attached incident report in three bullet points for the on-call engineer.",
  "Write a SQL query that returns the top 10 customers by revenue for the last quarter, grouped by region.",
  "Translate 'Your invoice is overdue' into French, German and Spanish.",
  "Explain the difference between optimistic and pessimistic locking, with a short example in Python.",
];
for (const [i, content] of prompts.entries()) {
  await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.keys[i % 2 ? "support-bot" : "prod-openai"].raw}` },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content }] }),
  });
}

// an empty workspace (empty states) and a user with no workspace (Get started)
const empty = await actor("emptyadmin");
await empty.call("POST", "/api/workspace", { name: "Empty Co" });
creds.users.empty = "emptyadmin";
await actor("newcomer");
creds.users.newcomer = "newcomer";

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(creds, null, 2));
console.log("seeded accounts and keys ->", OUT);
await browser.close();
