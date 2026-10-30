import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { CheckIcon } from "../../components/ui/icons";

function Step({
  n,
  done,
  title,
  text,
  action,
}: {
  n: number;
  done: boolean;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr_auto] items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-semibold ${
          done ? "border-success-line bg-success-soft text-success-fg" : "border-control text-fg-muted"
        }`}
      >
        {done ? <CheckIcon size={13} /> : n}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-fg">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </div>
        <div className="text-sm text-fg-muted">{text}</div>
      </div>
      {action}
    </li>
  );
}

/** The first run, in order: a provider key, a virtual key, an app calling the gateway. Each step is checked off from
 *  what the workspace already has, so it is never stale and never needs dismissing. */
export function Checklist({
  hasProvider,
  hasKey,
  hasRequests,
  onProviders,
  onCreate,
  onConnect,
}: {
  hasProvider: boolean;
  hasKey: boolean;
  hasRequests: boolean;
  onProviders: () => void;
  onCreate: () => void;
  /** undefined while there is no key to connect */
  onConnect?: () => void;
}) {
  const done = [hasProvider, hasKey, hasRequests].filter(Boolean).length;
  return (
    <section aria-labelledby="setup-title" className="rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4">
        <div>
          <h2 id="setup-title" className="text-base font-semibold text-fg">
            Set up your gateway
          </h2>
          <p className="text-sm text-fg-muted">Three steps and your first request shows up on the Dashboard.</p>
        </div>
        <span className="text-sm text-fg-muted">{done} of 3 done</span>
      </div>
      <ol>
        <Step
          n={1}
          done={hasProvider}
          title="Add a provider key"
          text={hasProvider ? "A provider is connected. Add more any time under Providers." : "Attach your OpenAI, Anthropic, Gemini or OpenRouter key so the gateway can call the provider."}
          action={
            <Button size="sm" onClick={onProviders}>
              {hasProvider ? "Manage providers" : "Add a provider key"}
            </Button>
          }
        />
        <Step
          n={2}
          done={hasKey}
          title="Create a virtual key"
          text="One per app or teammate, so usage and budgets stay separate. The secret is shown once."
          action={
            !hasKey && (
              <Button variant="primary" size="sm" onClick={onCreate}>
                Create your first key
              </Button>
            )
          }
        />
        <Step
          n={3}
          done={hasRequests}
          title="Point your app at the gateway"
          text="Change the base URL and use the virtual key. We show the exact lines for your SDK."
          action={
            !hasRequests && (
              <Button size="sm" disabled={!onConnect} onClick={onConnect}>
                How to connect
              </Button>
            )
          }
        />
      </ol>
    </section>
  );
}
