export interface Filters {
  rangeDays: number; // 0 = all time; ignored when `start` is set
  start: string; // "YYYY-MM-DD" custom-range start (empty => use rangeDays)
  end: string; // "YYYY-MM-DD" custom-range end, inclusive
  provider: string;
  model: string;
  keyId: string;
}

export const DEFAULT_RANGE_DAYS = 30;

export const defaultFilters: Filters = {
  rangeDays: DEFAULT_RANGE_DAYS,
  start: "",
  end: "",
  provider: "",
  model: "",
  keyId: "",
};

/** today (0) or N days ago, as YYYY-MM-DD in UTC */
export function isoDate(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.start) {
    p.set("start", new Date(f.start + "T00:00:00Z").toISOString());
    if (f.end) {
      const e = new Date(f.end + "T00:00:00Z");
      e.setUTCDate(e.getUTCDate() + 1); // end date is inclusive
      p.set("end", e.toISOString());
    }
  } else if (f.rangeDays > 0) {
    p.set("start", new Date(Date.now() - f.rangeDays * 86_400_000).toISOString());
  }
  if (f.provider) p.set("provider", f.provider);
  if (f.model) p.set("model", f.model);
  if (f.keyId) p.set("key_id", f.keyId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const RANGE_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "All", value: 0 },
];

const shortDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The time range in words, for the page's context line ("Last 30 days", "Oct 9 – Oct 30", "All time"). */
export function describeRange(f: Filters): string {
  if (f.start) return `${shortDate(f.start)} – ${f.end ? shortDate(f.end) : "today"}`;
  if (f.rangeDays > 0) return `Last ${f.rangeDays} days`;
  return "All time";
}

const DAY_MS = 86_400_000;

/** The same filters for the period just before the chosen one, of the same length (for "vs the previous 30 days").
 *  null for "All time", which has nothing before it. */
export function previousQuery(f: Filters): { qs: string; label: string } | null {
  let start: number;
  let end: number;
  let label: string;
  if (f.start) {
    start = Date.parse(f.start + "T00:00:00Z");
    end = f.end ? Date.parse(f.end + "T00:00:00Z") + DAY_MS : Date.now();
    label = "previous period";
  } else if (f.rangeDays > 0) {
    end = Date.now();
    start = end - f.rangeDays * DAY_MS;
    label = `previous ${f.rangeDays} days`;
  } else {
    return null;
  }
  if (!(end > start)) return null;
  const p = new URLSearchParams();
  p.set("start", new Date(start - (end - start)).toISOString());
  p.set("end", new Date(start).toISOString()); // the end of a window is exclusive
  if (f.provider) p.set("provider", f.provider);
  if (f.model) p.set("model", f.model);
  if (f.keyId) p.set("key_id", f.keyId);
  return { qs: `?${p.toString()}`, label };
}
