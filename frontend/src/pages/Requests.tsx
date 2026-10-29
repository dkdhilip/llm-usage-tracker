import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  PROVIDERS,
  type KeyRow,
  type ModelInfo,
  type RequestContent,
  type StoredImage,
  type RequestRow,
} from "../lib/api";
import { Card } from "../components/Card";
import { costSourceLabel, providerName, relTime, usd } from "../lib/format";

const FILTER_KEYS = ["key_id", "provider", "model", "status", "start", "end"] as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</span>
      {children}
    </label>
  );
}

export function Requests() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [bodiesLogged, setBodiesLogged] = useState(true);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const [contentLogging, setContentLogging] = useState(false);
  const [content, setContent] = useState<RequestContent | null>(null);
  const [contentErr, setContentErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
    api.listKeys().then(setKeys).catch(() => setKeys([]));
  }, []);

  const activeFilters: [string, string][] = FILTER_KEYS.flatMap((k) => {
    const v = params.get(k);
    return v != null ? [[k, v] as [string, string]] : [];
  });
  const filterKey = params.toString();
  const hasFilters = activeFilters.length > 0;

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key === "provider") next.delete("model"); // model list depends on provider
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const modelOptions = useMemo(() => {
    const p = params.get("provider");
    const list = p ? models.filter((m) => m.provider === p) : models;
    return list.map((m) => m.model);
  }, [models, params]);

  const load = useCallback(
    (after: number | null) => {
      const p = new URLSearchParams(params);
      p.set("limit", "50");
      if (after) p.set("cursor", String(after));
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
        .catch((e: Error) => setError(e.message));
    },
    [params],
  );

  useEffect(() => {
    load(null);
  }, [load, filterKey]);

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
  }, [open]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-fg">Request log</h1>
        <button
          onClick={() => load(null)}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-fg-muted hover:bg-fill"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
        <Field label="Key">
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={params.get("key_id") ?? ""}
            onChange={(e) => setFilter("key_id", e.target.value)}
          >
            <option value="">All keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider">
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={params.get("provider") ?? ""}
            onChange={(e) => setFilter("provider", e.target.value)}
          >
            <option value="">All</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {providerName(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={params.get("model") ?? ""}
            onChange={(e) => setFilter("model", e.target.value)}
          >
            <option value="">All</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={params.get("status") ?? ""}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </Field>
        <Field label="From">
          <input
            type="date"
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={(params.get("start") ?? "").slice(0, 10)}
            onChange={(e) => setFilter("start", e.target.value)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={(params.get("end") ?? "").slice(0, 10)}
            onChange={(e) => setFilter("end", e.target.value)}
          />
        </Field>
        {hasFilters && (
          <button
            onClick={() => navigate("/requests")}
            className="ml-auto self-center text-brand-600 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      {!bodiesLogged && !contentLogging && (
        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          Prompts and responses are not stored. Workspace admins can turn on prompt &amp; response
          logging in the Workspace settings.
        </div>
      )}

      <Card>
        <div className="relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" tabIndex={0} role="region" aria-label="Request log table">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-subtle">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Key</th>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3 text-right">Tokens</th>
                <th className="py-2 pr-3 text-right">Cost</th>
                <th className="py-2 pr-3 text-right">Latency</th>
                <th className="py-2 pr-0 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-fg-subtle">
                    No requests yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpen(r)}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-fill"
                >
                  <td className="py-2 pr-3 text-xs text-fg-subtle">{relTime(r.ts)}</td>
                  <td className="py-2 pr-3">{r.key_label}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {r.provider}/{r.model}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.total_tokens}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {usd(r.cost)}
                    <span className="ml-1 text-[10px] text-fg-subtle">
                      {costSourceLabel(r.cost_source)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.latency_ms} ms</td>
                  <td className="py-2 pr-0 text-center">
                    <span
                      className={
                        r.status === "error" ? "text-red-600 dark:text-red-400" : "text-fg-subtle"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more && (
          <button
            onClick={() => load(cursor)}
            className="mt-3 w-full rounded-md border border-line py-1.5 text-sm text-brand-600 hover:bg-fill"
          >
            Load more
          </button>
        )}
      </Card>

      {open && (
        <div
          className="fixed inset-0 z-20 flex justify-end bg-black/20"
          onClick={() => setOpen(null)}
        >
          <div
            className="h-full w-full max-w-lg overflow-y-auto bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-fg">Request detail</h2>
              <button
                onClick={() => setOpen(null)}
                className="text-fg-subtle hover:text-fg"
              >
                ✕
              </button>
            </div>
            <dl className="space-y-1.5 text-sm">
              {[
                ["Request ID", open.request_id],
                ["Time", new Date(open.ts).toLocaleString()],
                ["Key", `${open.key_label} (${open.key_prefix}…)`],
                ["Provider / model", `${open.provider}/${open.model}`],
                [
                  "Tokens",
                  `${open.prompt_tokens} prompt · ${open.completion_tokens} completion · ${open.total_tokens} total`,
                ],
                [
                  "Cost",
                  `${usd(open.cost)} (${costSourceLabel(open.cost_source, true)})`,
                ],
                ["Latency", `${open.latency_ms} ms`],
                ["Status", open.status],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-32 shrink-0 text-fg-subtle">{k}</dt>
                  <dd className="font-mono text-xs text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            {open.has_content && (
              <StoredContentView content={content} error={contentErr} usageId={open.id} />
            )}
            {/* The old LOG_BODIES previews: only shown when one actually exists (the flag is off in production,
                so these used to be two permanent "not stored" boxes under the real stored content). */}
            {(open.prompt_preview != null || open.response_preview != null) && (
              <div className="mt-4 space-y-3" data-testid="legacy-previews">
                {open.prompt_preview != null && (
                  <div>
                    <div className="text-xs font-medium text-fg-subtle">Prompt preview</div>
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-fg">
                      {open.prompt_preview}
                    </pre>
                  </div>
                )}
                {open.response_preview != null && (
                  <div>
                    <div className="text-xs font-medium text-fg-subtle">Response preview</div>
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-fg">
                      {open.response_preview}
                    </pre>
                  </div>
                )}
              </div>
            )}
            {!open.has_content && open.prompt_preview == null && open.response_preview == null && (
              <p className="mt-4 text-xs text-fg-subtle" data-testid="nothing-stored">
                No prompt or response was stored for this request.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SKIP_TEXT: Record<string, string> = {
  url_not_stored: "image given as a link (links are never downloaded or stored)",
  not_fetchable: "image referenced by a file id or URI",
  too_large: "image too large to store",
  unsupported_type: "not a PNG, JPEG, GIF or WebP image",
  request_limit: "per-request image limit reached",
  cap_reached: "image storage limit reached",
  not_in_stream: "images in streamed responses are not stored",
};

function ImageThumb({ usageId, img }: { usageId: number; img: StoredImage }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed)
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded border border-line bg-surface-2 p-1 text-center text-[10px] text-fg-subtle">
        Image unavailable (expired or unreadable)
      </div>
    );
  const url = api.requestImageUrl(usageId, img.id);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={`${img.mime}, ${Math.ceil(img.bytes / 1024)} KB`}>
      {/* The <img> is always laid out (a display:none image is never fetched by the browser); the pulse
          placeholder just sits behind it until it has loaded. */}
      <span className={"relative inline-block rounded " + (loaded ? "" : "min-h-24 min-w-24 animate-pulse bg-fill")}>
        <img
          src={url}
          alt={`${img.role} image ${img.position + 1}`}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="block max-h-48 max-w-full rounded border border-line object-contain"
        />
      </span>
    </a>
  );
}

function ImagesBlock({ usageId, content }: { usageId: number; content: RequestContent }) {
  const images = content.images ?? [];
  const skipped = content.content?.images_skipped ?? [];
  if (!images.length && !skipped.length) return null;
  const group = (role: "input" | "output", label: string) => {
    const imgs = images.filter((i) => i.role === role);
    const sk = skipped.filter((s) => s.role === role);
    if (!imgs.length && !sk.length) return null;
    return (
      <div>
        <div className="text-xs font-medium text-fg-subtle">{label}</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {imgs.map((i) => (
            <ImageThumb key={i.id} usageId={usageId} img={i} />
          ))}
        </div>
        {sk.map((s, n) => (
          <div key={n} className="mt-1 text-xs text-fg-subtle">
            Not stored: {SKIP_TEXT[s.reason] ?? s.reason}
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="space-y-2">
      {group("input", "Images sent")}
      {group("output", "Images generated")}
    </div>
  );
}

function StoredContentView({
  content,
  error,
  usageId,
}: {
  content: RequestContent | null;
  error: string | null;
  usageId: number;
}) {
  if (error)
    return <div className="mt-4 text-xs text-red-600 dark:text-red-400">{error}</div>;
  if (!content) return <div className="mt-4 text-xs text-fg-subtle">Loading stored content…</div>;
  if (content.content_status !== "available" || !content.content)
    return (
      <div className="mt-4 text-xs text-fg-subtle">
        {content.content_status === "expired" && `Stored content expired (kept ${content.retention_days} days).`}
        {content.content_status === "unreadable" && "Stored content can no longer be decrypted."}
        {content.content_status === "not_captured" && "No content was stored for this request."}
      </div>
    );
  const { request, response } = content.content;
  const input = Array.isArray(request.input) ? request.input.join("\n") : request.input;
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-3">
      <div className="text-xs font-medium text-fg">
        Stored content
        {content.expires_at && (
          <span className="ml-2 font-normal text-fg-subtle">
            deleted {new Date(content.expires_at).toLocaleDateString()}
          </span>
        )}
      </div>
      {request.system && <Block label="System" text={request.system} />}
      {request.messages?.map((m, i) => <Block key={i} label={m.role} text={m.text} />)}
      {input && <Block label="Input" text={input} />}
      {request.prompt && <Block label="Prompt" text={request.prompt} />}
      <ImagesBlock usageId={usageId} content={content} />
      <Block label="Response" text={response.text || response.summary || "—"} />
      {response.text && response.summary && <Block label="Response summary" text={response.summary} />}
      {(content.request_truncated || content.response_truncated) && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          Truncated:{" "}
          {[content.request_truncated && "request", content.response_truncated && "response"]
            .filter(Boolean)
            .join(" and ")}{" "}
          exceeded the storage limit.
        </div>
      )}
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-fg-subtle">{label}</div>
      <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-fg">{text}</pre>
    </div>
  );
}
