import type { ReactNode } from "react";
import { CopyButton } from "../../components/ui/CopyButton";

/** Something shown once and never again (a new key, an invite code): the value in a box, with Copy. */
export function SecretBox({
  title,
  value,
  what,
  children,
}: {
  title: ReactNode;
  value: string;
  /** what is being copied, for the announcement ("Key", "Invite code") */
  what: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-success-line bg-success-soft p-3">
      <div className="text-ui font-medium text-success-fg">{title}</div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1.5 font-mono text-xs text-fg">{value}</code>
        <CopyButton label="Copy" what={what} text={value} />
      </div>
      {children && <div className="mt-2 text-xs text-success-fg">{children}</div>}
    </div>
  );
}
