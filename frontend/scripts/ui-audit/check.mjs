// UI regression gate. Runs against the local audit app (see README) and compares with thresholds.json.
//   node scripts/ui-audit/check.mjs [--shots] [--quick]
// --shots saves screenshots to scripts/ui-audit/out/shots; --quick runs the 1440 and 390 widths only.
import { chromium } from "playwright-core";
import axe from "axe-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const BASE = process.env.UI_AUDIT_BASE || `http://127.0.0.1:${process.env.PORT || 8765}`;
const SHOTS = process.argv.includes("--shots");
const QUICK = process.argv.includes("--quick");
const creds = JSON.parse(readFileSync(join(OUT, "creds.json"), "utf-8"));
const thresholds = JSON.parse(readFileSync(join(HERE, "thresholds.json"), "utf-8"));
mkdirSync(join(OUT, "state"), { recursive: true });
if (SHOTS) mkdirSync(join(OUT, "shots"), { recursive: true });
const browser = await chromium.launch({ channel: process.env.UI_AUDIT_BROWSER || "chrome", headless: true });

async function context(user, width, theme = "light", extra = {}) {
  const stateFile = join(OUT, "state", `${user}.json`);
  if (user && !existsSync(stateFile)) {
    const c = await browser.newContext({ baseURL: BASE });
    const p = await c.newPage();
    await p.goto("/login");
    await p.getByLabel("Username").fill(user);
    await p.getByLabel("Password").fill(creds.password);
    await p.getByRole("button", { name: "Sign in" }).last().click();
    await p.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
    await c.storageState({ path: stateFile });
    await c.close();
  }
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, colorScheme: theme, ...(user ? { storageState: stateFile } : {}), ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch {} }, theme);
  return ctx;
}

// ---- measurements that run inside the page
const MEASURE = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const nameOf = (e) => (e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") && document.getElementById(e.getAttribute("aria-labelledby"))?.textContent) || (e.labels && e.labels[0]?.textContent) || e.textContent || e.value || e.title || "").trim().replace(/\s+/g, " ");
  const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[tabindex="0"]')].filter(vis);
  // WCAG 2.5.8: 24x24 CSS px. Exempt: inline text links, native checkbox/radio (the user-agent control; the label is the hit area).
  // (.sr-only is the skip link: it is full size when focused)
  const small = controls.filter((e) => { if (e.type === "checkbox" || e.type === "radio") return false; if (e.classList.contains("sr-only")) return false; const r = e.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && !(e.tagName === "A" && getComputedStyle(e).display === "inline"); });
  const noName = controls.filter((e) => !nameOf(e));
  let chars = 0, under12 = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const t = walker.currentNode; const txt = t.textContent.trim(); const el = t.parentElement; if (!txt || !el || !vis(el) || el.closest("script,style")) continue; const px = parseFloat(getComputedStyle(el).fontSize); chars += txt.length; if (px < 12) under12 += txt.length; }
  // WCAG 1.4.11: the boundary of a text field / select must be 3:1 against what is behind it
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const rgb = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const behind = (el) => { let e = el.parentElement; while (e) { const x = rgb(getComputedStyle(e).backgroundColor); if (x && x.a > 0.5) return x.c; e = e.parentElement; } return [255, 255, 255]; };
  const ratios = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea")].filter(vis).map((e) => { const cs = getComputedStyle(e); const b = rgb(cs.borderTopColor); if (!b || parseFloat(cs.borderTopWidth) === 0) return 0; const l1 = lum(b.c), l2 = lum(behind(e)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); });
  const minControlBorder = ratios.length ? Math.round(Math.min(...ratios) * 100) / 100 : null;
  return { minControlBorder, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, small: small.length, smallSamples: small.slice(0, 4).map((e) => `${nameOf(e).slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`), unnamed: noName.length, unnamedSamples: noName.slice(0, 3).map((e) => e.outerHTML.slice(0, 90)), pctUnder12: chars ? Math.round((under12 / chars) * 100) : 0 };
};
const FOCUS_INFO = () => {
  const el = document.activeElement; if (!el || el === document.body) return null;
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1));
  return { name: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.tagName).trim().replace(/\s+/g, " ").slice(0, 30), tag: el.tagName.toLowerCase(), ring: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none") || (el.tagName === "INPUT" && !el.matches(":focus")) /* focus is on the browser's own calendar button inside the date field, which Chrome outlines itself */, covered: !!top && top !== el && !el.contains(top) && !top.contains(el) };
};
async function axeRun(page) {
  await page.evaluate(axe.source);
  return page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
}
async function load(page, path, wait) {
  await page.goto(path);
  if (wait) await page.locator(wait).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
}

const PAGES = [
  { name: "login", user: null, path: "/login" },
  { name: "welcome", user: "newcomer", path: "/welcome" },
  { name: "dashboard", user: "auditadmin", path: "/dashboard", wait: ".recharts-wrapper" },
  { name: "requests", user: "auditadmin", path: "/requests", wait: "tbody tr, [data-request-row]" },
  { name: "playground", user: "auditadmin", path: "/playground" },
  { name: "workspace", user: "auditadmin", path: "/workspace", wait: "text=Virtual keys" },
  { name: "account", user: "auditadmin", path: "/account" },
  { name: "member-dashboard", user: "samuel", path: "/dashboard", wait: ".recharts-wrapper" },
  { name: "empty-dashboard", user: "emptyadmin", path: "/dashboard" },
  { name: "styleguide", user: null, path: "/styleguide", wait: "text=Design system" },
];
const WIDTHS = QUICK ? [1440, 390] : [1440, 1024, 768, 390, 360];
const DARK = new Set(["dashboard", "requests", "playground", "workspace", "styleguide"]);

const results = { matrix: {}, checks: {} };
// ================= matrix: overflow, axe, targets, names, small type
for (const theme of ["light", "dark"]) {
  for (const w of WIDTHS) {
    if (theme === "dark" && ![1440, 390].includes(w)) continue;
    for (const pg of PAGES) {
      if (theme === "dark" && !DARK.has(pg.name)) continue;
      const ctx = await context(pg.user, w, theme);
      const page = await ctx.newPage();
      try {
        await load(page, pg.path, pg.wait);
        if (SHOTS) await page.screenshot({ path: join(OUT, "shots", `${pg.name}-${w}-${theme}.png`), fullPage: true });
        const m = await page.evaluate(MEASURE);
        m.axe = await axeRun(page);
        results.matrix[`${pg.name}|${w}|${theme}`] = m;
      } catch (e) {
        results.matrix[`${pg.name}|${w}|${theme}`] = { error: String(e).slice(0, 160) };
      }
      await ctx.close();
    }
  }
}

// ================= interaction checks. Each is {pass, detail}
const check = async (name, fn) => { try { results.checks[name] = await fn(); } catch (e) { results.checks[name] = { pass: false, detail: "error: " + String(e).slice(0, 140) }; } };

await check("keyboardTabStops", async () => {
  const out = {};
  for (const [name, user, path, wait] of [["dashboard", "auditadmin", "/dashboard", ".recharts-wrapper"], ["requests", "auditadmin", "/requests", "tbody tr, [data-request-row]"], ["workspace", "auditadmin", "/workspace", "text=Virtual keys"]]) {
    const ctx = await context(user, 1440); const page = await ctx.newPage(); await load(page, path, wait);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    const stops = [];
    for (let i = 0; i < 120; i++) { await page.keyboard.press("Tab"); const f = await page.evaluate(FOCUS_INFO); if (!f) break; if (stops.length > 3 && stops[0].name === f.name && stops[0].tag === f.tag) break; stops.push(f); }
    out[name] = { stops: stops.length, noRing: stops.filter((s) => !s.ring).length, noRingNames: stops.filter((s) => !s.ring).slice(0, 3).map((s) => `${s.tag}:${s.name}`), covered: stops.filter((s) => s.covered).length };
    await ctx.close();
  }
  const bad = Object.entries(out).filter(([, v]) => v.noRing || v.covered);
  return { pass: bad.length === 0, detail: JSON.stringify(out) };
});

await check("requestsRowOpensByKeyboard", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/requests", "tbody tr, [data-request-row]");
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  let opened = false;
  for (let i = 0; i < 80 && !opened; i++) { await page.keyboard.press("Tab"); const inList = await page.evaluate(() => !!document.activeElement?.closest("tbody, [data-request-row]")); if (inList) { await page.keyboard.press("Enter"); await page.waitForTimeout(200); opened = await page.evaluate(() => !!document.querySelector('[role="dialog"], [aria-label="Request inspector"], .fixed.inset-0')); } }
  await ctx.close(); return { pass: opened, detail: opened ? "opened with Enter" : "no row could be opened with Tab + Enter" };
});

await check("requestInspectorSemantics", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/requests", "tbody tr, [data-request-row]");
  const rows = page.locator("tbody tr[data-request-row]");
  await rows.first().click(); await page.waitForTimeout(500);
  const info = () => page.evaluate(() => { const d = document.querySelector('aside[aria-label="Request inspector"]'); const cur = document.querySelector('tr[aria-current="true"]'); return { open: !!d, focusInside: !!d?.contains(document.activeElement), selected: cur?.getAttribute("data-request-row") ?? null, url: location.search }; });
  const a = await info();
  const named = await page.evaluate(() => [...document.querySelectorAll('aside[aria-label="Request inspector"] button')].every((b) => (b.getAttribute("aria-label") || b.textContent || "").trim()));
  await page.locator("tbody tr[data-request-row]").nth(0).focus(); await page.keyboard.press("j"); await page.waitForTimeout(150);
  const afterJ = await info();
  await page.keyboard.press("k"); await page.waitForTimeout(150);
  const afterK = await info();
  await page.locator('aside[aria-label="Request inspector"] h2').focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({ gone: !document.querySelector('aside[aria-label="Request inspector"]'), focusOnRow: !!document.activeElement?.closest("tr[data-request-row]") }));
  await ctx.close();
  const pass = a.open && a.focusInside && named && afterJ.selected !== a.selected && afterK.selected === a.selected && closed.gone && closed.focusOnRow;
  return { pass, detail: JSON.stringify({ opened: a.open, focusMovedIn: a.focusInside, buttonsNamed: named, jMoves: afterJ.selected !== a.selected, kBack: afterK.selected === a.selected, escCloses: closed.gone, focusReturnsToRow: closed.focusOnRow, url: a.url }) };
});

await check("requestInspectorAccessible", async () => {
  // the open inspector (beside the list at 1440, a full-screen detail at 390), light and dark, with stored content shown
  const out = {};
  for (const [w, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    const ctx = await context("auditadmin", w, theme); const page = await ctx.newPage(); await load(page, "/requests", "[data-request-row]");
    const sel = w >= 1100 ? "tr[data-request-row]" : "button[data-request-row]";
    const withContent = page.locator(sel, { has: page.locator("text=Content") }).first();
    await ((await withContent.count()) ? withContent : page.locator(sel).first()).click();
    await page.waitForTimeout(900);
    if (SHOTS) await page.screenshot({ path: join(OUT, "shots", `request-open-${w}-${theme}.png`), fullPage: w < 1100 });
    const v = await axeRun(page); const m = await page.evaluate(MEASURE);
    out[`${w}-${theme}`] = { axe: v.reduce((a, x) => a + x.n, 0), ids: v.map((x) => x.id).join(","), unnamed: m.unnamed, small: m.small, overflow: m.overflow };
    await ctx.close();
  }
  const bad = Object.values(out).filter((v) => v.axe || v.unnamed || v.overflow > 0);
  return { pass: bad.length === 0, detail: JSON.stringify(out) };
});

await check("requestDeepLink", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/requests", "tbody tr, [data-request-row]");
  await page.locator("tbody tr[data-request-row]").nth(1).click(); await page.waitForTimeout(400);
  const url = page.url(); const id = new URL(url).searchParams.get("r");
  const p2 = await ctx.newPage(); await load(p2, `/requests?r=${id}`, "tbody tr, [data-request-row]");
  const ok = await p2.evaluate((i) => !!document.querySelector('aside[aria-label="Request inspector"]') && document.querySelector('tr[aria-current="true"]')?.getAttribute("data-request-row") === i, id);
  const bad = await ctx.newPage(); await load(bad, "/requests?r=999999", "tbody tr, [data-request-row]");
  const dropped = await bad.evaluate(() => !document.querySelector('aside[aria-label="Request inspector"]') && !location.search.includes("r="));
  await ctx.close(); return { pass: !!id && ok && dropped, detail: `r=${id} reopens=${ok} unknownDropped=${dropped}` };
});

await check("requestDetailOnPhone", async () => {
  const ctx = await context("auditadmin", 390); const page = await ctx.newPage(); await load(page, "/requests", "[data-request-row]");
  const cards = page.locator("button[data-request-row]"); const n = await cards.count();
  await cards.first().click(); await page.waitForTimeout(400);
  const d = await page.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, back: !!document.querySelector('button[aria-label="Back to requests list"]'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, listGone: !document.querySelector('ul[aria-label="Requests"]'), inUrl: location.search.includes("r="), focusOnHeading: document.activeElement?.tagName === "H1" }));
  await page.goBack(); await page.waitForTimeout(400);
  const backViaBrowser = await page.evaluate(() => !!document.querySelector('ul[aria-label="Requests"]') && !location.search.includes("r="));
  await cards.first().click(); await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Back to requests list" }).click(); await page.waitForTimeout(400);
  const e = await page.evaluate(() => ({ listBack: !!document.querySelector('ul[aria-label="Requests"]'), focusOnCard: !!document.activeElement?.closest("button[data-request-row]") }));
  await ctx.close();
  const pass = n > 0 && d.h1 === "Request" && d.back && d.overflow <= 0 && d.listGone && d.inUrl && d.focusOnHeading && backViaBrowser && e.listBack && e.focusOnCard;
  return { pass, detail: JSON.stringify({ cards: n, ...d, browserBackCloses: backViaBrowser, ...e }) };
});

await check("confirmDialogTrapAndReturn", async () => {
  // Revoke now lives in the key's "⋯" menu: open it, choose Revoke, then the dialog must trap Tab and give focus back
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/workspace", "text=Virtual keys");
  const kebab = page.getByRole("button", { name: "More actions for mixed-key" }); await kebab.focus(); await kebab.click(); await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: "Revoke key" }).click(); await page.waitForTimeout(500);
  const found = await page.evaluate(() => !!document.querySelector('[role="alertdialog"],[role="dialog"]'));
  let inside = 0; if (found) for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); inside += await page.evaluate(() => (document.querySelector('[role="alertdialog"],[role="dialog"]')?.contains(document.activeElement) ? 1 : 0)); }
  if (found) { await page.keyboard.press("Escape"); await page.waitForTimeout(400); }
  const back = found ? await page.evaluate(() => /more actions for mixed-key/i.test(document.activeElement?.getAttribute("aria-label") || "")) : false;
  await ctx.close(); return { pass: found && inside === 8 && back, detail: `dialog=${found} tabsInside=${inside}/8 focusReturnedToKeyMenu=${back}` };
});

await check("workspaceTabs", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/workspace", "text=Virtual keys");
  const names = await page.getByRole("tab").allTextContents();
  const first = await page.getByRole("tab", { name: /^Keys/ }).getAttribute("aria-selected");
  await page.getByRole("tab", { name: /^Keys/ }).focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(150);
  const moved = await page.evaluate(() => document.activeElement?.getAttribute("role") === "tab" && /Providers/.test(document.activeElement.textContent));
  await page.keyboard.press("Enter"); await page.waitForTimeout(400);
  const providers = await page.evaluate(() => ({ url: location.search, shown: /Provider keys/.test(document.body.innerText), keysGone: !document.getElementById("keys-title") }));
  const p2 = await ctx.newPage(); await load(p2, "/workspace?tab=settings");
  const deep = await p2.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent);
  await ctx.close();
  const pass = names.length === 4 && first === "true" && moved && providers.url === "?tab=providers" && providers.shown && providers.keysGone && deep === "Settings";
  return { pass, detail: JSON.stringify({ tabs: names, defaultKeys: first === "true", arrowMoves: moved, ...providers, deepLinkSettings: deep }) };
});

await check("keyMenuKeyboard", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/workspace", "text=Virtual keys");
  const kebab = page.getByRole("button", { name: "More actions for prod-openai" }); await kebab.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const menu = await page.evaluate(() => { const m = document.querySelector('[role="menu"]'); return { open: !!m, items: [...(m?.querySelectorAll('[role="menuitem"]') ?? [])].map((i) => i.textContent.trim()), focusIn: !!m?.contains(document.activeElement) }; });
  await page.keyboard.press("ArrowDown"); await page.waitForTimeout(100);
  const moved = await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem");
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ closed: !document.querySelector('[role="menu"]'), focusBack: /more actions for prod-openai/i.test(document.activeElement?.getAttribute("aria-label") || "") }));
  await ctx.close();
  return { pass: menu.open && menu.focusIn && menu.items.includes("Revoke key") && moved && after.closed && after.focusBack, detail: JSON.stringify({ ...menu, arrowFocusesItem: moved, ...after }) };
});

await check("createKeyDrawer", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/workspace", "text=Virtual keys");
  const trigger = page.getByRole("button", { name: "Create key" }); await trigger.focus(); await trigger.click(); await page.waitForTimeout(500);
  const open = await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); return { dialog: !!d, named: d?.getAttribute("aria-labelledby") ? !!document.getElementById(d.getAttribute("aria-labelledby"))?.textContent : false, focusIn: !!d?.contains(document.activeElement) }; });
  await page.mouse.click(40, 400); await page.waitForTimeout(300);
  const stillOpen = await page.evaluate(() => !!document.querySelector('[role="dialog"]')); // a stray click must not close it
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ closed: !document.querySelector('[role="dialog"]'), focusBack: /create key/i.test(document.activeElement?.textContent || "") }));
  await ctx.close();
  return { pass: open.dialog && open.named && open.focusIn && stillOpen && after.closed && after.focusBack, detail: JSON.stringify({ ...open, outsideClickKeepsOpen: stillOpen, ...after }) };
});

await check("keysTableFitsDesktop", async () => {
  // every column, including the "⋯" actions, is visible at 1440 without sideways scrolling inside the card
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/workspace", "text=Virtual keys");
  const r = await page.evaluate(() => { const region = document.querySelector('[aria-label="Virtual keys table"]'); const kebab = document.querySelector('button[aria-label^="More actions for"]'); const box = kebab?.getBoundingClientRect(); const rb = region?.getBoundingClientRect(); return { scrolls: region ? region.scrollWidth - region.clientWidth : -1, kebabInside: !!(box && rb && box.right <= rb.right + 1) }; });
  await ctx.close(); return { pass: r.scrolls === 0 && r.kebabInside, detail: JSON.stringify(r) };
});

await check("workspaceAccessible", async () => {
  // every tab, the open key menu and the open drawer, light and dark, desktop and phone
  const out = {};
  for (const [w, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    const ctx = await context("auditadmin", w, theme); const page = await ctx.newPage();
    for (const tab of ["keys", "providers", "team", "settings"]) {
      await load(page, tab === "keys" ? "/workspace" : `/workspace?tab=${tab}`, "[role=tabpanel]");
      if (SHOTS) await page.screenshot({ path: join(OUT, "shots", `workspace-${tab}-${w}-${theme}.png`), fullPage: true });
      const v = await axeRun(page); const m = await page.evaluate(MEASURE);
      out[`${tab}-${w}-${theme}`] = { axe: v.reduce((a, x) => a + x.n, 0), ids: v.map((x) => x.id).join(","), unnamed: m.unnamed, small: m.small, overflow: m.overflow };
    }
    await load(page, "/workspace", "text=Virtual keys");
    await page.getByRole("button", { name: /^More actions for/ }).first().click(); await page.waitForTimeout(300);
    let v = await axeRun(page); out[`menu-${w}-${theme}`] = { axe: v.reduce((a, x) => a + x.n, 0), ids: v.map((x) => x.id).join(",") };
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Create key" }).click(); await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: join(OUT, "shots", `workspace-drawer-${w}-${theme}.png`) });
    v = await axeRun(page); out[`drawer-${w}-${theme}`] = { axe: v.reduce((a, x) => a + x.n, 0), ids: v.map((x) => x.id).join(",") };
    await ctx.close();
  }
  const bad = Object.entries(out).filter(([, v]) => v.axe || v.unnamed || v.overflow > 0);
  return { pass: bad.length === 0, detail: bad.length ? JSON.stringify(Object.fromEntries(bad)) : `${Object.keys(out).length} views, 0 violations` };
});

await check("noNativeConfirmDialogs", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); const seen = [];
  page.on("dialog", async (d) => { seen.push(d.message().slice(0, 40)); await d.dismiss(); });
  await load(page, "/account"); await page.getByRole("button", { name: /Delete account/ }).click(); await page.waitForTimeout(300);
  await ctx.close(); return { pass: seen.length === 0, detail: seen.length ? `native confirm shown: ${seen[0]}` : "custom dialog" };
});

await check("dashboardErrorAnnounced", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage();
  await page.route("**/api/usage/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "database unavailable" }) }));
  await load(page, "/dashboard"); const a = await page.evaluate(() => !!document.querySelector('[role="alert"]'));
  const wrongEmpty = await page.evaluate(() => /No usage in this range yet/.test(document.querySelector("main")?.innerText || ""));
  await ctx.close(); return { pass: a && !wrongEmpty, detail: `announced=${a} showsNoUsageDuringError=${wrongEmpty}` };
});

await check("dashboardLoadingIsNotEmpty", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage();
  await page.route("**/api/usage/**", async (r) => { await new Promise((x) => setTimeout(x, 2500)); r.continue(); });
  await page.goto("/dashboard"); await page.waitForTimeout(1000);
  const wrongEmpty = await page.evaluate(() => /No usage in this range yet/.test(document.querySelector("main")?.innerText || ""));
  await ctx.close(); return { pass: !wrongEmpty, detail: wrongEmpty ? "says 'No usage' while loading" : "loading state" };
});

await check("networkFailureIsNotSignedOut", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage();
  await page.route("**/api/**", (r) => r.abort("failed")); await load(page, "/dashboard");
  const signIn = await page.evaluate(() => /Sign in to your workspace/.test(document.body.innerText));
  await ctx.close(); return { pass: !signIn, detail: signIn ? "shows the Sign in form when the network fails" : "keeps context" };
});

await check("routeTitlesAndSkipLink", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); const titles = {};
  for (const p of ["/dashboard", "/requests", "/playground", "/workspace", "/account"]) { await load(page, p); titles[p] = await page.title(); }
  const skip = await page.evaluate(() => !!document.querySelector('a[href="#main"], a[href="#content"], a.skip-link'));
  await ctx.close(); const distinct = new Set(Object.values(titles)).size === 5; return { pass: distinct && skip, detail: `distinctTitles=${distinct} skipLink=${skip}` };
});

await check("reducedMotion", async () => {
  const ctx = await context("auditadmin", 1440, "light", { reducedMotion: "reduce" }); const page = await ctx.newPage();
  await page.route("**/api/usage/**", async (r) => { await new Promise((x) => setTimeout(x, 1500)); r.continue(); });
  await page.goto("/dashboard"); await page.waitForTimeout(500);
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
  await ctx.close(); return { pass: running === 0, detail: `${running} animations running with prefers-reduced-motion` };
});

await check("comboboxKeyboard", async () => {
  const ctx = await context("auditadmin", 1440); const page = await ctx.newPage(); await load(page, "/dashboard", ".recharts-wrapper");
  const trigger = page.getByRole("combobox", { name: /^Model:/ });
  await trigger.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const searchFocused = await page.evaluate(() => document.activeElement?.getAttribute("placeholder")?.startsWith("Search") ?? false);
  await page.keyboard.type("4o-mini"); await page.waitForTimeout(250);
  const filtered = await page.locator("[cmdk-item]").count();
  await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const chosen = await trigger.getAttribute("aria-label");
  await trigger.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(200); await page.keyboard.press("Escape"); await page.waitForTimeout(250);
  const closed = (await page.locator("[cmdk-item]").count()) === 0;
  const focusBack = await page.evaluate(() => /^Model:/.test(document.activeElement?.getAttribute("aria-label") || ""));
  await ctx.close();
  const ok = searchFocused && filtered >= 1 && filtered < 10 && /4o-mini/.test(chosen || "") && closed && focusBack;
  return { pass: ok, detail: `searchFocusedOnOpen=${searchFocused} optionsAfterTyping=${filtered} chosen="${chosen}" escapeCloses=${closed} focusReturns=${focusBack}` };
});

await check("reflowAt320And640", async () => {
  const out = {};
  for (const w of [640, 320]) for (const [n, path] of [["dashboard", "/dashboard"], ["requests", "/requests"], ["playground", "/playground"], ["workspace", "/workspace"], ["account", "/account"]]) {
    const ctx = await context("auditadmin", w); const page = await ctx.newPage(); await load(page, path, n === "dashboard" ? ".recharts-wrapper" : undefined);
    out[`${n}@${w}`] = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); await ctx.close();
  }
  const bad = Object.entries(out).filter(([, v]) => v > 0); return { pass: bad.length === 0, detail: bad.length ? JSON.stringify(bad) : "no horizontal scroll" };
});

await browser.close();

// ================= report and compare with thresholds.json
const rows = Object.entries(results.matrix);
const fails = [];
const worst = (f) => Math.max(0, ...rows.map(([, m]) => (m.error ? 0 : f(m))));
const total = { overflow: worst((m) => m.overflow), axe: rows.reduce((a, [, m]) => a + (m.axe ? m.axe.reduce((x, v) => x + v.n, 0) : 0), 0), unnamed: rows.reduce((a, [, m]) => a + (m.unnamed || 0), 0) };
const lowest = rows.filter(([, m]) => !m.error && m.minControlBorder != null).map(([k, m]) => [m.minControlBorder, k]).sort((a, b) => a[0] - b[0])[0];
const smallBy = {}; for (const [k, m] of rows) if (!m.error && k.endsWith("|1440|light")) smallBy[k.split("|")[0]] = m.small;
for (const [k, m] of rows) if (m.error) fails.push(`matrix ${k}: ${m.error}`);
if (total.overflow > thresholds.maxOverflowPx) fails.push(`page overflow ${total.overflow}px > ${thresholds.maxOverflowPx}`);
if (total.axe > thresholds.maxAxeViolationNodes) fails.push(`axe violation nodes ${total.axe} > ${thresholds.maxAxeViolationNodes}`);
if (total.unnamed > thresholds.maxUnnamedControls) fails.push(`unnamed controls ${total.unnamed} > ${thresholds.maxUnnamedControls}`);
if (lowest && lowest[0] < thresholds.minControlBorderContrast) fails.push(`field border contrast ${lowest[0]}:1 < ${thresholds.minControlBorderContrast}:1 (${lowest[1]})`);
for (const [pg, n] of Object.entries(smallBy)) { const max = thresholds.maxSmallTargets[pg] ?? thresholds.maxSmallTargets.default; if (n > max) fails.push(`targets under 24px on ${pg}: ${n} > ${max}`); }
for (const name of thresholds.requiredChecks) if (!results.checks[name]?.pass) fails.push(`check "${name}" must pass: ${results.checks[name]?.detail}`);

console.log(`\nMATRIX (${rows.length} renders)  overflow max ${total.overflow}px | axe nodes ${total.axe} | unnamed controls ${total.unnamed}`);
console.log("lowest text-field border contrast:", lowest ? `${lowest[0]}:1 on ${lowest[1]}` : "n/a");
console.log("targets under 24px @1440 light:", JSON.stringify(smallBy));
console.log("\nCHECKS");
for (const [name, c] of Object.entries(results.checks)) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${c.detail}`);
const axeAll = {}; for (const [, m] of rows) for (const v of m.axe || []) axeAll[v.id] = (axeAll[v.id] || 0) + v.n;
if (Object.keys(axeAll).length) console.log("\naxe rules:", JSON.stringify(axeAll));
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
console.log(fails.length ? `\nFAILED vs thresholds.json:\n  - ${fails.join("\n  - ")}` : "\nOK: within thresholds.json");
process.exit(fails.length ? 1 : 0);
