import * as RT from "@radix-ui/react-tabs";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export const Tabs = RT.Root;

/** The row of tabs. It scrolls sideways on a narrow screen (so no tab is cut off) and the arrow keys move between
 *  tabs; the panel of the selected tab is the next thing in the tab order. */
export function TabList({ className, ...rest }: ComponentPropsWithoutRef<typeof RT.List>) {
  return <RT.List className={cn("mb-4 flex gap-1 overflow-x-auto border-b border-line", className)} {...rest} />;
}

export function Tab({ className, children, count, ...rest }: ComponentPropsWithoutRef<typeof RT.Trigger> & { count?: number }) {
  return (
    <RT.Trigger
      className={cn(
        "-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 text-sm font-medium text-fg-muted",
        "hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text",
        "data-[state=active]:border-brand-600 data-[state=active]:text-brand-text",
        className,
      )}
      {...rest}
    >
      {children}
      {count != null && <span className="rounded-full bg-fill px-1.5 text-xs font-medium text-fg-muted">{count}</span>}
    </RT.Trigger>
  );
}

export function TabPanel({ className, ...rest }: ComponentPropsWithoutRef<typeof RT.Content>) {
  return <RT.Content className={cn("focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text", className)} {...rest} />;
}
