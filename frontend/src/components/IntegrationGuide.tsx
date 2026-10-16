import { useEffect, useState } from "react";
import {
  api,
  type IntegrationGuideData,
  type IntegrationProvider,
  type IntegrationProviderId,
  type IntegrationTarget,
} from "../lib/api";

// What the guide needs to know about a key — never the key itself. The guide only ever shows the
// `vk_...` placeholder: a key is displayed once at creation and is not stored, so it must not be
// threaded through here just to fill in a snippet.
export interface GuideKey {
  allowed_providers: string[];
  allow_live: boolean;
  expires_at?: string | null; // null/absent = never expires
}

export interface ReadinessCheck {
  ok: boolean;
  label: string;
  fix: string;
}

const ORDER: IntegrationProviderId[] = ["openai", "anthropic", "gemini"];

// The things that must all be true before a request succeeds, from data the Workspace page already
// holds: provider enabled, live on, workspace credential — plus, for a key that has an expiry, that it
// has not passed (an expired key is refused with the same 401 as a revoked one). A per-key model
// allow-list is explained in the notes.
export function keyReadiness(
  provider: IntegrationProviderId,
  providerLabel: string,
  key: GuideKey,
  configuredProviders: string[],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    {
      ok: key.allowed_providers.includes(provider),
      label: `${providerLabel} is enabled for this key`,
      fix: "Create a key that allows this provider.",
    },
    {
      ok: key.allow_live,
      label: "Live calls are on",
      fix: "Switch the key to LIVE in the keys table — a paused key answers 403.",
    },
    {
      ok: configuredProviders.includes(provider),
      label: `The workspace holds a real ${providerLabel} credential`,
      fix: "Add it under Provider keys. It stays in the gateway — never in your application.",
    },
  ];
  if (key.expires_at) {
    const when = new Date(key.expires_at);
    const expired = when.getTime() <= Date.now();
    checks.push({
      ok: !expired,
      label: expired ? `This key expired on ${when.toLocaleDateString()}` : `The key has not expired (expires ${when.toLocaleDateString()})`,
      fix: "Create a new key — an expired key is refused with a 401.",
    });
  }
  return checks;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-line px-2 py-0.5 text-[11px] text-fg-muted hover:bg-fill"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">{title}</span>
        <CopyButton text={text} label={title} />
      </div>
      <pre className="overflow-x-auto rounded-md bg-fill p-3 font-mono text-xs leading-relaxed text-fg">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function IntegrationGuide({
  keyInfo,
  configuredProviders,
}: {
  keyInfo?: GuideKey;
  configuredProviders: string[];
}) {
  const [target, setTarget] = useState<IntegrationTarget>("hosted");
  const [guide, setGuide] = useState<IntegrationGuideData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<IntegrationProviderId>(
    () => ORDER.find((p) => keyInfo?.allowed_providers.includes(p)) ?? "openai",
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Drop the previous target's snippets the moment a new request starts: while it is loading, or if it
    // fails, nothing from the other gateway may sit under the newly selected Hosted/Local toggle.
    setGuide(null);
    api
      .integrationGuide(target)
      .then((g) => !cancelled && setGuide(g))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const p: IntegrationProvider | undefined = guide?.providers.find((x) => x.provider === active);
  const checks = p && keyInfo ? keyReadiness(p.provider, p.label, keyInfo, configuredProviders) : [];

  return (
    <section aria-label="Connect your app" className="space-y-3">
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

      {guide && (
        <p className="text-xs text-fg-muted">
          Gateway: <code className="font-mono text-fg">{guide.gateway_url}</code>
        </p>
      )}
      {error && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div>}

      <div role="tablist" aria-label="Provider" className="flex gap-1 border-b border-line">
        {ORDER.map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={active === id}
            onClick={() => setActive(id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              active === id ? "border-brand-500 font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {guide?.providers.find((x) => x.provider === id)?.label ?? id}
          </button>
        ))}
      </div>

      {p && (
        <div role="tabpanel" className="space-y-3">
          {p.intro && <p className="text-sm text-fg">{p.intro}</p>}
          {keyInfo && (
            <ul aria-label="Readiness" className="space-y-1 text-xs">
              {checks.map((c) => (
                <li key={c.label} data-ok={c.ok} className="flex gap-2">
                  <span aria-hidden className={c.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                    {c.ok ? "✓" : "✗"}
                  </span>
                  <span className={c.ok ? "text-fg-muted" : "text-fg"}>
                    {c.label}
                    {!c.ok && <span className="text-fg-muted"> — {c.fix}</span>}
                  </span>
                </li>
              ))}
              <li className="flex gap-2 text-fg-muted">
                <span aria-hidden>•</span>
                <span>The model must be allowed — a key can carry a model allow-list; a model outside it answers 403.</span>
              </li>
            </ul>
          )}

          <Block title="1. Install" text={p.install} />
          <Block title="2. .env (git-ignored)" text={p.env_file} />
          <Block title="3. Minimal request" text={p.code} />
          {p.alt_code && <Block title={p.alt_title || "3b. Alternative: explicit configuration"} text={p.alt_code} />}
          <p className="text-xs text-fg-muted">
            Endpoint: <code className="font-mono text-fg">{p.endpoint}</code>
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {guide && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <ul className="list-disc space-y-1 pl-4">
            {guide.general_notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-fg-subtle">
        Several projects or providers? Copy <code className="font-mono">examples/gateway-sdks/gateway_client.py</code>:
        set <code className="font-mono">LLM_GATEWAY_KEY</code> once per project, and rotating a key is a one-line edit.
      </p>
    </section>
  );
}
