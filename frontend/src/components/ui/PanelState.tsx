import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

/** Where a panel's data is: still loading, failed to load, or here. A panel must say which, instead of showing
 *  "No usage" (which means "loaded, and there is none") while it is loading or after an error. */
export type PanelStatus = "ready" | "loading" | "error";

/** What a chart or table card shows in place of its content until its data is ready. The page-level error alert
 *  carries the message and the Retry; the panel only says its own data is unavailable. */
export function PanelPlaceholder({ state, className }: { state: Exclude<PanelStatus, "ready">; className?: string }) {
  if (state === "loading") return <Skeleton className={cn("w-full", className)} />;
  return (
    <div className={cn("flex w-full items-center justify-center rounded-md border border-dashed border-line px-4 text-center text-sm text-fg-muted", className)}>
      Couldn&apos;t load this data.
    </div>
  );
}
