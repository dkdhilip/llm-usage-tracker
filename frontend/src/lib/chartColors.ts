// One palette for every chart, so a provider has the same colour in the bars, the stacked chart and the model list.
// It is built on the Okabe-Ito colour-blind-safe set, with the lightest members darkened a little so each colour is at
// least 3:1 against the white card and the dark card (WCAG 1.4.11). Every series also carries its name and its number in
// text beside the colour, so colour is never the only thing telling two providers apart.
export const PROVIDER_COLORS: Record<string, string> = {
  openai: "#009e73", // bluish green
  anthropic: "#d55e00", // vermillion
  gemini: "#0072b2", // blue
  openrouter: "#cc79a7", // reddish purple
};

// For any other provider: a stable pick from these, chosen to stay apart from the four above and from each other.
const FALLBACK = ["#7b61d9", "#c23b5a", "#8a8a96", "#a67c00"];

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
