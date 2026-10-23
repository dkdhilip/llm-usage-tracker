// One palette for every chart, so a provider has the same colour in the donut, the stacked area and the model bars.
// Chosen to stay distinct from each other and readable on both the light and the dark card.
export const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  openrouter: "#6366f1",
  gemini: "#3b82f6",
};

const FALLBACK = ["#14b8a6", "#f43f5e", "#eab308", "#8b5cf6", "#06b6d4", "#84cc16"];

/** The colour for a provider: its fixed brand-ish colour, or a stable pick from the fallback list. */
export function providerColor(name: string): string {
  const known = PROVIDER_COLORS[name];
  if (known) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/** "12%" / "3.4%" / "<1%" for `part` of `total`. Only a provider holding everything reads "100%": a large share
 *  that merely rounds up (99.6%) stays at 99% so it never looks like the others are zero. */
export function shareLabel(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  if (part >= total) return "100%";
  const pct = (part / total) * 100;
  if (pct < 1) return "<1%";
  return `${pct >= 10 ? Math.min(99, Math.round(pct)) : pct.toFixed(1)}%`;
}
