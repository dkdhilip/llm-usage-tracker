export interface KeyOption {
  key_id: number;
  label: string;
}

/** The keys offered in the Dashboard "All keys" filter: every key in the list (even one that has not made a
 *  request yet) plus any key that has usage (so a deleted key's history can still be filtered), each once. */
export function keyOptions(
  keys: { id: number; label: string; deleted_at?: string | null }[],
  used: { key_id: number; label: string }[],
): KeyOption[] {
  const byId = new Map<number, KeyOption>();
  for (const k of keys) if (!k.deleted_at) byId.set(k.id, { key_id: k.id, label: k.label });
  for (const u of used) if (!byId.has(u.key_id)) byId.set(u.key_id, { key_id: u.key_id, label: u.label });
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
