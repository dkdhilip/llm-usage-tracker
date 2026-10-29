const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

/** A provider id as people write it: "openai" -> "OpenAI", "openrouter" -> "OpenRouter". */
export function providerName(p: string): string {
  return PROVIDER_NAMES[p.toLowerCase()] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);
}

export interface CostText {
  text: string;
  /** true when the model has no price, so the cost is unknown (not zero) */
  unknown: boolean;
  /** extra words after the amount, e.g. "+3 unpriced" when only some requests have a price */
  note?: string;
  title?: string;
}

/** How to show a cost total. `unpriced` is how many of `requests` have no cost at all (the model has no price):
 *  those add nothing to `cost`, so a bare "$0.000000" would read as "free". Only a request that was priced at
 *  exactly $0 is free. An API that does not send the count is treated safely: a 0 total counts as unknown. */
export function costLabel(cost: number, requests: number, unpriced?: number): CostText {
  if (requests <= 0) return { text: "—", unknown: false };
  const u = unpriced ?? (cost === 0 ? requests : 0);
  if (u >= requests) {
    return {
      text: "No price yet",
      unknown: true,
      title: "These requests have no cost: the model has no price in the catalog, so its cost is unknown (not free).",
    };
  }
  if (u > 0) {
    return {
      text: usd(cost),
      unknown: false,
      note: `+${num(u)} unpriced`,
      title: `${num(u)} of ${num(requests)} requests have no price yet, so the real cost is higher than this.`,
    };
  }
  if (cost === 0) return { text: "Free", unknown: false, title: "These requests were priced at $0." };
  return { text: usd(cost), unknown: false };
}

export function usd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

// cost_source: "provider" (real charge) | "workspace" (this workspace's own
// price override) | "configured" (built-in/JSON price table) | "unknown"
// (cost is null — an honest gap, never a fabricated number).
export function costSourceLabel(source: string, long = false): string {
  switch (source) {
    case "provider":
      return long ? "provider actual" : "actual";
    case "workspace":
      return long ? "your workspace's price" : "your price";
    case "configured":
      return long ? "estimated" : "est";
    default:
      return "unknown";
  }
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function num(n: number): string {
  return n.toLocaleString();
}

export function relTime(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}
