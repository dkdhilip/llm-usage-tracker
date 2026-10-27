export type KeyStatus = "active" | "revoked" | "deleted";

export const KEY_STATUSES: { id: KeyStatus; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "revoked", label: "Revoked" },
  { id: "deleted", label: "Deleted" },
];

/** What the key filters show until the user ticks more. */
export const DEFAULT_KEY_STATUSES: KeyStatus[] = ["active"];

export interface KeyOption {
  key_id: number;
  label: string;
  status: KeyStatus;
}

/** Deleted wins over revoked (a key is revoked before it can be deleted); otherwise active. */
export function keyStatus(k: { revoked_at?: string | null; deleted_at?: string | null }): KeyStatus {
  if (k.deleted_at) return "deleted";
  return k.revoked_at ? "revoked" : "active";
}

/** Every key in the list (even one that has not made a request yet) plus any key that has usage but is not in
 *  the list, each once, with its status. A key with usage that the list no longer returns can only be a deleted
 *  one (members' lists leave deleted keys out), so it is "deleted". */
export function keyOptions(
  keys: { id: number; label: string; revoked_at?: string | null; deleted_at?: string | null }[],
  used: { key_id: number; label: string }[],
): KeyOption[] {
  const byId = new Map<number, KeyOption>();
  for (const k of keys) byId.set(k.id, { key_id: k.id, label: k.label, status: keyStatus(k) });
  for (const u of used) if (!byId.has(u.key_id)) byId.set(u.key_id, { key_id: u.key_id, label: u.label, status: "deleted" });
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** Toggle one status in the ticked set, never leaving it empty (at least one stays ticked). */
export function toggleStatus(current: KeyStatus[], s: KeyStatus): KeyStatus[] {
  if (!current.includes(s)) return KEY_STATUSES.map((x) => x.id).filter((id) => id === s || current.includes(id));
  return current.length === 1 ? current : current.filter((x) => x !== s);
}
