import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Nothing here yet, and what to do about it. Use it for a true empty result, never while loading or after an error. */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      {icon && <div className="mb-1 text-fg-subtle">{icon}</div>}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description && <p className="max-w-md text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
