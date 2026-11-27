import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type RequestContent, type StoredImage } from "../../lib/api";
import { CopyButton } from "../../components/ui/CopyButton";
import { Mark } from "../workspace/guardrails/Snippet";
import { findRanges, type MatchedWords, type Range } from "./matches";

const SKIP_TEXT: Record<string, string> = {
  url_not_stored: "image given as a link (links are never downloaded or stored)",
  not_fetchable: "image referenced by a file id or URI",
  too_large: "image too large to store",
  unsupported_type: "not a PNG, JPEG, GIF or WebP image",
  request_limit: "per-request image limit reached",
  cap_reached: "image storage limit reached",
  not_in_stream: "images in streamed responses are not stored",
};

type Part = { label: string; text: string };

/** The stored request as labelled parts, in reading order (system, messages, input, prompt). */
export function promptParts(content: RequestContent): Part[] {
  const request = content.content?.request;
  if (!request) return [];
  const parts: Part[] = [];
  if (request.system) parts.push({ label: "system", text: request.system });
  for (const m of request.messages ?? []) parts.push({ label: m.role, text: m.text });
  const input = Array.isArray(request.input) ? request.input.join("\n") : request.input;
  if (input) parts.push({ label: "input", text: input });
  if (request.prompt) parts.push({ label: "prompt", text: request.prompt });
  return parts;
}

/** The prompt as plain text, for the clipboard. */
export function promptText(content: RequestContent): string {
  const parts = promptParts(content);
  return parts.length === 1 ? parts[0].text : parts.map((p) => `${p.label}: ${p.text}`).join("\n\n");
}

export function responseText(content: RequestContent): string {
  const r = content.content?.response;
  return r ? r.text || r.summary || "" : "";
}

function ImageThumb({ usageId, img }: { usageId: number; img: StoredImage }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed)
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded border border-line bg-surface-2 p-1 text-center text-meta text-fg-muted">
        Image unavailable (expired or unreadable)
      </div>
    );
  const url = api.requestImageUrl(usageId, img.id);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={`${img.mime}, ${Math.ceil(img.bytes / 1024)} KB`}>
      {/* The <img> is always laid out (a display:none image is never fetched by the browser); the pulse
          placeholder just sits behind it until it has loaded. */}
      <span className={"relative inline-block rounded " + (loaded ? "" : "min-h-24 min-w-24 animate-pulse bg-fill motion-reduce:animate-none")}>
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
        <div className="text-xs font-medium text-fg-muted">{label}</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {imgs.map((i) => (
            <ImageThumb key={i.id} usageId={usageId} img={i} />
          ))}
        </div>
        {sk.map((s, n) => (
          <div key={n} className="mt-1 text-xs text-fg-muted">
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

/** The heading level of the inspector's sections: 3 under the pane's own h2, 2 under the full-screen page's h1. */
export const SectionLevel = createContext<2 | 3>(3);

/** A section of the inspector: a heading, an optional action beside it, and the content. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const Heading = useContext(SectionLevel) === 2 ? "h2" : "h3";
  return (
    <section className="border-b border-line px-5 py-4 last:border-b-0">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
        <Heading className="text-meta font-semibold uppercase tracking-wider text-fg-muted">{title}</Heading>
        {action}
      </div>
      {children}
    </section>
  );
}

/** `text` with the given ranges highlighted. */
function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<Mark key={i}>{text.slice(a, b)}</Mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** Long text in a box that scrolls and can be reached by keyboard (so a long prompt can be read without a mouse).
 *  `words` are highlighted wherever they occur, and a long text scrolls to the first of them, so the admin sees the
 *  sentence that set a content rule off without hunting for it. */
export function TextBlock({ label, text, words }: { label: string; text: string; words?: readonly MatchedWords[] }) {
  const box = useRef<HTMLPreElement>(null);
  const ranges = useMemo(() => (words?.length ? findRanges(text, words) : []), [text, words]);
  useEffect(() => {
    const el = box.current;
    const first = ranges.length ? el?.querySelector("mark") : null;
    if (!el || !first) return;
    const room = el.getBoundingClientRect();
    const at = first.getBoundingClientRect();
    // only when it is out of sight; put it in the middle of the box
    if (at.top < room.top || at.bottom > room.bottom) el.scrollTop += at.top - room.top - (el.clientHeight - at.height) / 2;
  }, [ranges]);
  return (
    <pre
      ref={box}
      tabIndex={0}
      role="region"
      aria-label={label}
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-mono text-[13px] leading-5 text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text"
    >
      {ranges.length ? <Highlighted text={text} ranges={ranges} /> : text}
    </pre>
  );
}

/** The stored prompt and response (and images), or why there are none. Renders the Prompt and Response sections. */
export function StoredContentSections({
  content,
  error,
  usageId,
  requestOnly,
  words,
}: {
  content: RequestContent | null;
  error: string | null;
  usageId: number;
  /** a blocked request never reached the provider: there is no response to show */
  requestOnly?: boolean;
  /** the words a content rule matched in this request: highlighted in the prompt */
  words?: readonly MatchedWords[];
}) {
  if (error)
    return (
      <Section title="Stored content">
        <p role="alert" className="text-sm text-danger-fg">{error}</p>
      </Section>
    );
  if (!content)
    return (
      <Section title="Stored content">
        <p className="text-sm text-fg-muted">Loading stored content…</p>
      </Section>
    );
  if (content.content_status !== "available" || !content.content)
    return (
      <Section title="Stored content">
        <p className="text-sm text-fg-muted">
          {content.content_status === "expired" && `Stored content expired (kept ${content.retention_days} days).`}
          {content.content_status === "unreadable" && "Stored content can no longer be decrypted."}
          {content.content_status === "not_captured" && "No content was stored for this request."}
        </p>
      </Section>
    );
  const { response } = content.content;
  const parts = promptParts(content);
  const reply = responseText(content);
  const highlighted = !!words?.length && parts.some((p) => findRanges(p.text, words, 1).length > 0);
  return (
    <>
      {parts.length > 0 && (
        <Section title="Prompt" action={<CopyButton label="Copy prompt" what="Prompt" text={promptText(content)} />}>
          {highlighted && <p className="mb-2 text-xs text-fg-muted">The words a content rule matched are highlighted.</p>}
          <div className="space-y-3">
            {parts.map((p, i) => (
              <div key={i}>
                <div className="mb-1 text-xs font-medium capitalize text-fg-muted">{p.label}</div>
                <TextBlock label={`Prompt: ${p.label}`} text={p.text} words={words} />
              </div>
            ))}
          </div>
        </Section>
      )}
      <ImagesSection usageId={usageId} content={content} />
      {requestOnly ? (
        content.request_truncated && (
          <p className="px-5 pb-4 text-xs text-warning-fg">Truncated: the request exceeded the storage limit.</p>
        )
      ) : (
        <Section title="Response" action={<CopyButton label="Copy response" what="Response" text={responseText(content)} />}>
          {reply ? (
            <TextBlock label="Response" text={reply} />
          ) : (
            <p className="text-sm text-fg-muted">No response was stored. (Prompt logging is off, so only the prompt of a request a content rule matched is kept.)</p>
          )}
          {response.text && response.summary && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-fg-muted">Response summary</div>
              <TextBlock label="Response summary" text={response.summary} />
            </div>
          )}
          {(content.request_truncated || content.response_truncated) && (
            <p className="mt-3 text-xs text-warning-fg">
              Truncated:{" "}
              {[content.request_truncated && "request", content.response_truncated && "response"].filter(Boolean).join(" and ")}{" "}
              exceeded the storage limit.
            </p>
          )}
        </Section>
      )}
    </>
  );
}

function ImagesSection({ usageId, content }: { usageId: number; content: RequestContent }) {
  if (!(content.images?.length || content.content?.images_skipped?.length)) return null;
  return (
    <Section title="Images">
      <ImagesBlock usageId={usageId} content={content} />
    </Section>
  );
}
