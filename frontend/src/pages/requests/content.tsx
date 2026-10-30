import { createContext, useContext, useState } from "react";
import { api, type RequestContent, type StoredImage } from "../../lib/api";
import { CopyButton } from "./CopyButton";

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

/** Long text in a box that scrolls and can be reached by keyboard (so a long prompt can be read without a mouse). */
export function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={label}
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-mono text-[13px] leading-5 text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text"
    >
      {text}
    </pre>
  );
}

/** The stored prompt and response (and images), or why there are none. Renders the Prompt and Response sections. */
export function StoredContentSections({
  content,
  error,
  usageId,
}: {
  content: RequestContent | null;
  error: string | null;
  usageId: number;
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
  const reply = responseText(content) || "—";
  return (
    <>
      {parts.length > 0 && (
        <Section title="Prompt" action={<CopyButton label="Copy prompt" what="Prompt" text={promptText(content)} />}>
          <div className="space-y-3">
            {parts.map((p, i) => (
              <div key={i}>
                <div className="mb-1 text-xs font-medium capitalize text-fg-muted">{p.label}</div>
                <TextBlock label={`Prompt: ${p.label}`} text={p.text} />
              </div>
            ))}
          </div>
        </Section>
      )}
      <ImagesSection usageId={usageId} content={content} />
      <Section title="Response" action={<CopyButton label="Copy response" what="Response" text={responseText(content)} />}>
        <TextBlock label="Response" text={reply} />
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
