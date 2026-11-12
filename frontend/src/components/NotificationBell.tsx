import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type GuardrailHitGroup } from "../lib/api";
import { relTime } from "../lib/format";
import { pageContainer } from "../lib/portal";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { BellIcon } from "./ui/icons";

const POLL_MS = 60_000;
const CAP = 99;

/** How many content-rule matches nobody has reviewed yet. It is read once, then every minute while the page is
 *  visible, and again when the tab or window regains focus. A failed read keeps the last number (a bell that
 *  flickers to zero on a network blip would hide real alerts). */
export function useUnreadMatches(enabled: boolean) {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    Promise.resolve()
      .then(() => api.guardrails.unreadCount())
      .then((r) => setCount(r.count))
      .catch(() => {});
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const tick = window.setInterval(() => document.visibilityState !== "hidden" && refresh(), POLL_MS);
    const wake = () => document.visibilityState !== "hidden" && refresh();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled, refresh]);
  return { count, setCount, refresh };
}

const label = (n: number) => (n > CAP ? `${CAP}+` : String(n));

/** The bell in the header (workspace admins only). Its number is the unread matches of content rules; opening it lists
 *  them grouped by key and rule, links each group to the matching requests, and lets the admin mark them reviewed.
 *  Reviewing is workspace-wide and only covers what is on screen: a match that arrives while the list is open stays
 *  unread. */
export function NotificationBell() {
  const { count, setCount, refresh } = useUnreadMatches(true);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<GuardrailHitGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const seen = useRef(0);

  // a screen reader is told when the number goes UP (new matches), once, not on every poll
  useEffect(() => {
    if (count > seen.current) setAnnounce(`${label(count)} unread content rule match${count === 1 ? "" : "es"}`);
    seen.current = count;
  }, [count]);

  const load = useCallback(() => {
    setErr(null);
    api.guardrails
      .hitGroups()
      .then((r) => {
        setGroups(r.items);
        setCount(r.unread_total);
      })
      .catch((e: Error) => setErr(e.message));
  }, [setCount]);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) load();
    else refresh();
  };

  const upTo = (items: GuardrailHitGroup[]) => Math.max(0, ...items.map((g) => g.last_hit_id));

  async function review(items: GuardrailHitGroup[], one?: GuardrailHitGroup) {
    setBusy(true);
    setErr(null);
    try {
      await api.guardrails.reviewHits(
        one
          ? { up_to_id: one.last_hit_id, key_id: one.key_id, rule_id: one.rule_id, action: one.action }
          : { up_to_id: upTo(items) },
      );
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unreadGroups = (groups ?? []).filter((g) => g.unread > 0);

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={count > 0 ? `Notifications, ${label(count)} unread` : "Notifications, none unread"}
            aria-haspopup="dialog"
            aria-expanded={open}
            title="Content rule matches"
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-control bg-surface text-fg hover:bg-fill focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          >
            <BellIcon />
            {count > 0 && (
              <span
                aria-hidden="true"
                data-testid="bell-count"
                className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-meta font-semibold leading-none text-white"
              >
                {label(count)}
              </span>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal container={pageContainer()}>
          <Popover.Content
            align="end"
            sideOffset={6}
            aria-label="Content rule notifications"
            className="z-50 w-[26rem] max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface-raised p-3 shadow-lg focus:outline-none"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-fg">Content rule matches</h2>
              {unreadGroups.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => review(groups ?? [])}>
                  Mark all reviewed
                </Button>
              )}
            </div>
            {err && (
              <p role="alert" className="mb-2 text-sm text-danger-fg">
                Couldn't load or update: {err}
              </p>
            )}
            {groups === null && !err && <p className="py-3 text-sm text-fg-muted">Loading…</p>}
            {groups && groups.length === 0 && <p className="py-3 text-sm text-fg-muted">No matches yet. When a request matches a content rule, it shows up here.</p>}
            {groups && groups.length > 0 && unreadGroups.length === 0 && <p className="pb-2 text-sm text-fg-muted">You're all caught up.</p>}
            {groups && groups.length > 0 && (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto" aria-label="Matches by key and rule">
                {groups.map((g) => (
                  <li key={`${g.key_id}-${g.rule_id}-${g.rule_name}-${g.action}`} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          to={`/requests?key_id=${g.key_id}&guardrail=${g.action === "block" ? "blocked" : "flagged"}`}
                          onClick={() => setOpen(false)}
                          className="break-words text-sm font-medium text-brand-text underline-offset-2 hover:underline"
                        >
                          {g.rule_name}
                          <span className="sr-only"> on {g.key_label}: view requests</span>
                        </Link>
                        <div className="text-xs text-fg-muted">
                          {g.key_label} · {relTime(g.last_seen)}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant={g.action === "block" ? "danger" : "warning"}>{g.action === "block" ? "Blocked" : "Flagged"}</Badge>
                        <span className="text-xs text-fg-muted">
                          {g.unread > 0 ? `${g.unread} unread` : "reviewed"} · {g.total} total
                        </span>
                      </div>
                    </div>
                    {g.unread > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => review(groups, g)}
                        className="mt-1 inline-flex min-h-7 items-center text-xs text-brand-text underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text"
                      >
                        Mark reviewed<span className="sr-only"> {g.rule_name} on {g.key_label}</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 border-t border-line pt-2 text-sm">
              <Link to="/requests?guardrail=any" onClick={() => setOpen(false)} className="text-brand-text underline-offset-2 hover:underline">
                See all matched requests
              </Link>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
