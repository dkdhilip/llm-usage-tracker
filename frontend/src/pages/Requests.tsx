import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type KeyRow, type ModelInfo, type RequestContent, type RequestRow } from "../lib/api";
import { cn } from "../lib/cn";
import { PHONE_QUERY, SPLIT_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { Button } from "../components/ui/Button";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshIcon } from "../components/ui/icons";
import { RequestFilters } from "./requests/RequestFilters";
import { RequestInspector } from "./requests/RequestInspector";
import { RequestList } from "./requests/RequestList";

const FILTER_KEYS = ["key_id", "provider", "model", "status", "start", "end"] as const;
/** The open request is in the URL as ?r=<id>, so it can be reloaded and the browser's Back button closes it. */
const OPEN_PARAM = "r";

const rowEl = (id: number | string) => document.querySelector<HTMLElement>(`[data-request-row="${id}"]`);

export function Requests() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const split = useMediaQuery(SPLIT_QUERY, true); // list and inspector side by side
  const phone = useMediaQuery(PHONE_QUERY);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [bodiesLogged, setBodiesLogged] = useState(true);
  const [contentLogging, setContentLogging] = useState(false);
  const [content, setContent] = useState<RequestContent | null>(null);
  const [contentErr, setContentErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocusTo = useRef<string | null>(null); // the row to focus again when the inspector closes
  const advanceFrom = useRef<number | null>(null); // "next" pressed on the last loaded row: open the one after it
  const pushed = useRef(false); // opening added a history entry, so Back should remove it rather than add another
  const wasOpen = useRef(false);

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
    api.listKeys().then(setKeys).catch(() => setKeys([]));
  }, []);

  const get = (k: string) => params.get(k) ?? "";
  const filterKey = FILTER_KEYS.flatMap((k) => (params.get(k) != null ? [`${k}=${params.get(k)}`] : [])).join("&");
  const hasFilters = filterKey !== "";

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key === "provider") next.delete("model"); // model list depends on provider
      next.delete(OPEN_PARAM); // a different list: the open request may not be in it
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const modelOptions = useMemo(() => {
    const p = params.get("provider");
    return (p ? models.filter((m) => m.provider === p) : models).map((m) => m.model);
  }, [models, params]);

  const load = useCallback(
    (after: number | null) => {
      const p = new URLSearchParams();
      for (const k of FILTER_KEYS) if (params.get(k) != null) p.set(k, params.get(k)!);
      p.set("limit", "50");
      if (after) p.set("cursor", String(after));
      setLoading(true);
      api
        .listRequests("?" + p.toString())
        .then((r) => {
          setRows((prev) => (after ? [...prev, ...r.items] : r.items));
          setCursor(r.next_cursor);
          setMore(r.next_cursor != null);
          setBodiesLogged(r.bodies_logged);
          setContentLogging(!!r.content_logging_enabled);
          setError(null);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    // reload only when a filter changes, never when the open request (?r=) does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const openId = params.get(OPEN_PARAM);
  const open = useMemo(() => rows.find((r) => String(r.id) === openId) ?? null, [rows, openId]);
  const idx = open ? rows.indexOf(open) : -1;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && (idx < rows.length - 1 || more);

  const select = useCallback(
    (row: RequestRow, replace: boolean) => {
      const next = new URLSearchParams(params);
      next.set(OPEN_PARAM, String(row.id));
      setParams(next, { replace });
    },
    [params, setParams],
  );

  const openRow = (row: RequestRow) => {
    const push = !split && !openId;
    if (push) pushed.current = true;
    select(row, !push);
  };

  const close = useCallback(() => {
    if (openId) restoreFocusTo.current = openId;
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete(OPEN_PARAM);
    setParams(next, { replace: true });
  }, [openId, params, navigate, setParams]);

  const step = (delta: 1 | -1) => {
    if (!open) return;
    const target = rows[idx + delta];
    if (target) select(target, true);
    else if (delta === 1 && more && !loading) {
      advanceFrom.current = open.id; // the next request is on the next page: fetch it, then open it
      load(cursor);
    }
  };

  // "Next" on the last loaded row: once more rows arrive, open the one after it
  useEffect(() => {
    if (advanceFrom.current == null) return;
    const at = rows.findIndex((r) => r.id === advanceFrom.current);
    if (at >= 0 && at < rows.length - 1) {
      select(rows[at + 1], true);
      advanceFrom.current = null;
    }
  }, [rows, select]);

  // A ?r= that is not in the loaded list (an old link, another page of results) is dropped.
  useEffect(() => {
    if (openId && !open && !loading) {
      const next = new URLSearchParams(params);
      next.delete(OPEN_PARAM);
      setParams(next, { replace: true });
    }
  }, [openId, open, loading, params, setParams]);

  useEffect(() => {
    if (!openId) pushed.current = false;
  }, [openId]);

  // Focus follows the inspector: into it when it opens (so a keyboard user need not tab through every row), and back
  // to the row it came from when it closes. Previous/next keep focus where it is.
  useEffect(() => {
    if (open && !wasOpen.current) heading.current?.focus();
    if (!open && wasOpen.current && restoreFocusTo.current) rowEl(restoreFocusTo.current)?.focus();
    if (!open) restoreFocusTo.current = null;
    wasOpen.current = !!open;
  }, [open]);

  useEffect(() => {
    if (open && split) rowEl(open.id)?.scrollIntoView({ block: "nearest" });
  }, [open, split]);

  // The stored prompt/response is fetched per request, only when the row says it has some.
  useEffect(() => {
    setContent(null);
    setContentErr(null);
    if (!open?.has_content) return;
    let live = true;
    api
      .requestContent(open.id)
      .then((c) => live && setContent(c))
      .catch((e: Error) => live && setContentErr(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id, open?.has_content]);

  // J / K step through requests and Escape closes the inspector, but only while focus is in the list or the inspector
  // (and not in a field), so a typed letter is never taken as a shortcut.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable='true']")) return;
    if (e.key === "Escape") close();
    else if (e.key === "j" || e.key === "J") step(1);
    else if (e.key === "k" || e.key === "K") step(-1);
  };

  const inspector = open && (
    <RequestInspector
      row={open}
      content={content}
      contentError={contentErr}
      mode={split ? "pane" : "page"}
      headingRef={heading}
      hasPrev={hasPrev}
      hasNext={hasNext}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onClose={close}
    />
  );

  // Narrower than the split: the inspector is a full-screen view of its own, with a Back button.
  if (open && !split) return <div onKeyDown={onKeyDown}>{inspector}</div>;

  return (
    <div className="space-y-4">
      <PageHeader
        className="mb-0"
        title="Requests"
        description="Every call through your gateway. Select one to inspect it."
        actions={
          <Button onClick={() => !loading && load(null)} aria-busy={loading}>
            <RefreshIcon /> Refresh
          </Button>
        }
      />

      {error && (
        <InlineAlert
          tone="error"
          title="Couldn't load requests"
          action={
            <Button size="sm" onClick={() => load(null)}>
              Retry
            </Button>
          }
        >
          {error}
        </InlineAlert>
      )}

      <RequestFilters
        get={get}
        set={setFilter}
        keys={keys}
        models={modelOptions}
        hasFilters={hasFilters}
        onClear={() => navigate("/requests")}
      />

      {!bodiesLogged && !contentLogging && (
        <InlineAlert tone="info" role="note">
          Prompts and responses are not stored. Workspace admins can turn on prompt &amp; response logging in the Workspace
          settings.
        </InlineAlert>
      )}

      <div className={cn("grid items-start gap-4", open && "grid-cols-[minmax(0,1fr)_460px]")} onKeyDown={onKeyDown}>
        <RequestList
          rows={rows}
          selectedId={open?.id ?? null}
          phone={phone}
          showTokens={!open}
          constrain={!!open}
          loading={loading}
          error={!!error}
          hasFilters={hasFilters}
          more={more}
          onOpen={openRow}
          onLoadMore={() => load(cursor)}
        />
        {inspector}
      </div>
    </div>
  );
}
