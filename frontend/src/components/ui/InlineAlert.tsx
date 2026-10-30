import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { AlertIcon, CheckIcon, InfoIcon } from "./icons";

export type AlertTone = "error" | "warning" | "info" | "success";

const TONE: Record<AlertTone, { box: string; icon: ReactNode; role: "alert" | "status" }> = {
  error: { box: "border-danger-line bg-danger-soft text-danger-fg", icon: <AlertIcon />, role: "alert" },
  warning: { box: "border-warning-line bg-warning-soft text-warning-fg", icon: <AlertIcon />, role: "status" },
  info: { box: "border-info-line bg-info-soft text-info-fg", icon: <InfoIcon />, role: "status" },
  success: { box: "border-success-line bg-success-soft text-success-fg", icon: <CheckIcon />, role: "status" },
};

/** A message in the flow of the page. An error is announced immediately (role="alert"); the other tones are
 *  announced politely (role="status"). Pass `action` for a recovery step such as a Retry button. */
export function InlineAlert({
  tone = "error",
  title,
  children,
  action,
  role,
  id,
  className,
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status" | "note";
  /** so a field can point at it with aria-describedby */
  id?: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div id={id} role={role ?? t.role} className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm", t.box, className)}>
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
