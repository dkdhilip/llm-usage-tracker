import { useId, useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { CheckIcon, ChevronDownIcon } from "../../components/ui/icons";
import { cn } from "../../lib/cn";

const REMEMBER = "gettingStartedOpen";

/** What the visitor chose last time (open or closed), or null if they never chose. */
function remembered(): boolean | null {
  try {
    const v = localStorage.getItem(REMEMBER);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null; // storage blocked
  }
}

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
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-semibold",
          done ? "border-success-line bg-success-soft text-success-fg" : "border-control text-fg-muted",
        )}
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

/** The first run, in order: a provider key, a virtual key, an app calling the gateway. It is a section you open and
 *  close: open by default while something is left to do, closed once everything is done (and then it just says so),
 *  and it remembers what you chose. Each step is checked off from what the workspace already has, so it is never
 *  stale. It is only drawn once that data has loaded: before then every step would read "not done". */
export function GettingStarted({
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
  const id = useId();
  const steps = [
    { done: hasProvider, title: "Add a provider key" },
    { done: hasKey, title: "Create a virtual key" },
    { done: hasRequests, title: "Point your app at the gateway" },
  ];
  const done = steps.filter((s) => s.done).length;
  const complete = done === steps.length;
  const next = steps.find((s) => !s.done);
  const variant = (i: number) => (steps[i] === next ? ("primary" as const) : ("secondary" as const));
  const [choice, setChoice] = useState<boolean | null>(remembered);
  const open = choice ?? !complete;

  const toggle = () => {
    setChoice(!open);
    try {
      localStorage.setItem(REMEMBER, open ? "0" : "1");
    } catch {
      /* storage blocked */
    }
  };

  return (
    <section className="rounded-xl border border-line bg-surface shadow-sm">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-steps`}
          onClick={toggle}
          className="flex w-full items-center gap-3 rounded-xl px-5 py-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-fg">
              Getting started
            </span>
            <span className="block text-sm font-normal text-fg-muted">
              {complete ? "Everything is set up. Open this any time to see the steps again." : `Next: ${next?.title}`}
            </span>
          </span>
          <span aria-hidden="true" className="hidden shrink-0 gap-1 sm:flex">
            {steps.map((s, i) => (
              <span key={i} className={cn("h-1.5 w-6 rounded-full", s.done ? "bg-success-line" : "bg-fill")} />
            ))}
          </span>
          <Badge variant={complete ? "success" : "neutral"} dot={complete}>
            {done} of {steps.length} steps done
          </Badge>
          <ChevronDownIcon aria-hidden="true" className={cn("shrink-0 text-fg-muted", open && "rotate-180")} />
        </button>
      </h2>
      {open && (
        <ol id={`${id}-steps`} className="border-t border-line">
          <Step
            n={1}
            done={hasProvider}
            title="Add a provider key"
            text={
              hasProvider
                ? "A provider is connected. Add more any time under Providers."
                : "Attach your OpenAI, Anthropic, Gemini or OpenRouter key so the gateway can call the provider."
            }
            action={
              <Button size="sm" variant={variant(0)} onClick={onProviders}>
                {hasProvider ? "Manage providers" : "Add a provider key"}
              </Button>
            }
          />
          <Step
            n={2}
            done={hasKey}
            title="Create a virtual key"
            text={
              hasKey
                ? "Your virtual keys are listed below. Make one per app or teammate."
                : "One per app or teammate, so usage and budgets stay separate. The secret is shown once."
            }
            action={
              !hasKey && (
                <Button variant={variant(1)} size="sm" onClick={onCreate}>
                  Create your first key
                </Button>
              )
            }
          />
          <Step
            n={3}
            done={hasRequests}
            title="Point your app at the gateway"
            text={
              hasRequests
                ? "The gateway has served requests. See them on the Requests page."
                : "Change the base URL and use the virtual key. We show the exact lines for your SDK."
            }
            action={
              !hasRequests && (
                <Button size="sm" variant={variant(2)} disabled={!onConnect} title={onConnect ? undefined : "Create a virtual key first"} onClick={onConnect}>
                  How to connect
                </Button>
              )
            }
          />
        </ol>
      )}
    </section>
  );
}
