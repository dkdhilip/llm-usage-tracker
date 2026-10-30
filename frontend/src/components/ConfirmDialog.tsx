import { useRef, type ReactNode } from "react";
import { Button } from "./ui/Button";
import { Dialog, DialogContent } from "./ui/Dialog";
import { InlineAlert } from "./ui/InlineAlert";

/** A confirmation for an action that cannot be undone from the UI (or that shares something sensitive). It is a real
 *  modal dialog: focus is trapped inside, Escape or an outside click cancels, and focus returns to the control that
 *  opened it. Focus starts on Cancel so a stray Enter never confirms. Mount it while it should be open. */
export function ConfirmDialog({
  title,
  confirmLabel,
  tone = "danger",
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** "danger" is red (delete, revoke, remove); "default" is for a decision with consequences that is not destructive. */
  tone?: "danger" | "default";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        role="alertdialog"
        title={title}
        tone={tone}
        showClose={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={cancelRef} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant={tone === "danger" ? "destructive" : "primary"} disabled={busy} onClick={onConfirm}>
              {busy ? "Working…" : confirmLabel}
            </Button>
          </>
        }
      >
        <div className="space-y-2 px-4 py-3 text-sm text-fg-muted">{children}</div>
        {error && (
          <div className="px-4 pb-2">
            <InlineAlert tone="error">{error}</InlineAlert>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
