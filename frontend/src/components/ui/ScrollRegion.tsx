import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** A container that scrolls sideways (a wide table on a narrow screen). It is a named region that a keyboard user
 *  can focus and scroll with the arrow keys; `relative` keeps visually-hidden text inside it from widening the page. */
export function ScrollRegion({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "relative overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
        className,
      )}
    >
      {children}
    </div>
  );
}
