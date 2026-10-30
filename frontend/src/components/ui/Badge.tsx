import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger";

const VARIANT: Record<BadgeVariant, string> = {
  neutral: "bg-fill text-fg-muted",
  brand: "bg-info-soft text-info-fg",
  success: "bg-success-soft text-success-fg",
  warning: "bg-warning-soft text-warning-fg",
  danger: "bg-danger-soft text-danger-fg",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** A leading dot. Status is always the word plus the colour, never the colour alone. */
  dot?: boolean;
}

/** A compact label: a status ("Success", "Revoked"), a cost note ("No price yet"), a count. */
export function Badge({ variant = "neutral", dot, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium", VARIANT[variant], className)} {...rest}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
