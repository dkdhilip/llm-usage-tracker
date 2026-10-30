import { cn } from "../../lib/cn";

/** A placeholder block for content that is loading. It is hidden from assistive technology (announce the loading
 *  state with text or an InlineAlert), and it does not animate when the user prefers reduced motion. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-fill motion-reduce:animate-none", className)} />;
}
