import { useEffect, useState } from "react";
import {
  api,
  type IntegrationGuideData,
  type IntegrationProvider,
  type IntegrationProviderId,
  type IntegrationTarget,
} from "../lib/api";
import { IntegrationGuide, type GuideKey } from "./IntegrationGuide";
import { buttonClass } from "./ui/Button";
import { InlineAlert } from "./ui/InlineAlert";

const ORDER: IntegrationProviderId[] = ["openai", "anthropic", "gemini"];

/** The `NAME=value` lines to put in .env for one provider (the API key line and the base-URL line). */
export function envLines(p: IntegrationProvider): string[] {
  if (p.env_vars?.length) return p.env_vars.map((e) => `${e.name}=${e.value}`);
  return p.env_file
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="));
}

/** Which of the three guide entries a key needs. OpenRouter is reached through the OpenAI client, so a key that
 *  allows it shows the OpenAI lines (plus a note about the `openrouter/` model prefix). */
export function providersFor(allowed: string[] | undefined): IntegrationProviderId[] {
  if (!allowed) return ORDER;
  const need = new Set<IntegrationProviderId>();
  if (allowed.includes("openai") || allowed.includes("openrouter")) need.add("openai");
  if (allowed.includes("anthropic")) need.add("anthropic");
  if (allowed.includes("gemini")) need.add("gemini");
  return ORDER.filter((id) => need.has(id));
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={buttonClass("secondary", "sm")}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A short "what to change" box: only the providers this key allows, with just the two .env lines for each. The
 *  long walkthrough (install, code, readiness checklist, notes) stays available behind "Show full setup guide". */
export function ConnectPanel({
  keyInfo,
  configuredProviders,
}: {
  keyInfo?: GuideKey;
  configuredProviders: string[];
}) {
  const [target, setTarget] = useState<IntegrationTarget>("hosted");
  const [guide, setGuide] = useState<IntegrationGuideData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setGuide(null); // never leave the other gateway's URLs under a newly chosen Hosted/Local toggle
    api
      .integrationGuide(target)
      .then((g) => !cancelled && setGuide(g))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (full) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => setFull(false)} className="text-xs text-brand-600 hover:underline inline-flex min-h-7 items-center">
          ← Back to the short version
        </button>
        <IntegrationGuide keyInfo={keyInfo} configuredProviders={configuredProviders} />
      </div>
    );
  }

  const shown = providersFor(keyInfo?.allowed_providers);
  const viaOpenRouter = !!keyInfo?.allowed_providers.includes("openrouter");

  return (
    <section aria-label="Connect your app" className="space-y-3" data-testid="connect-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-fg">Connect your app</h4>
        <div role="group" aria-label="Gateway" className="inline-flex overflow-hidden rounded-md border border-line text-xs">
          {(["hosted", "local"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={target === t}
              onClick={() => setTarget(t)}
              className={`px-2.5 py-1 ${target === t ? "bg-brand-600 text-white" : "bg-surface text-fg-muted hover:bg-fill"}`}
            >
              {t === "hosted" ? "Hosted" : "Local"}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-fg-muted">
        In your app's <code className="font-mono text-fg">.env</code>, replace your real provider key with this virtual key
        and change the base URL to:
      </p>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {shown.map((id) => {
        const p = guide?.providers.find((x) => x.provider === id);
        if (!p) return null;
        const text = envLines(p).join("\n");
        return (
          <div key={id} data-testid={`connect-${id}`}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">
                {id === "openai" && viaOpenRouter && keyInfo?.allowed_providers.includes("openai") === false
                  ? "OpenRouter (through the OpenAI client)"
                  : id === "openai" && viaOpenRouter
                    ? "OpenAI and OpenRouter"
                    : p.label}
              </span>
              <CopyButton text={text} />
            </div>
            <pre className="overflow-x-auto rounded-md bg-fill p-3 font-mono text-xs leading-relaxed text-fg">
              <code>{text}</code>
            </pre>
            {id === "openai" && viaOpenRouter && (
              <p className="mt-1 text-xs text-fg-muted">
                For OpenRouter, use model names like <code className="font-mono">openrouter/&lt;vendor&gt;/&lt;model&gt;</code>.
              </p>
            )}
          </div>
        );
      })}

      <p className="text-xs text-fg-subtle">
        The virtual key is shown only once, when it is created. Never put a real provider key in your app.{" "}
        <button type="button" onClick={() => setFull(true)} className="text-brand-600 hover:underline inline-flex min-h-7 items-center">
          Show full setup guide
        </button>
      </p>
    </section>
  );
}
