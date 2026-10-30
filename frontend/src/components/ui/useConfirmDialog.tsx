import { useCallback, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "default";
}

/** A replacement for window.confirm that fits an async handler:
 *
 *    const { confirm, dialog } = useConfirmDialog();
 *    if (!(await confirm({ title, body, confirmLabel }))) return;
 *    ...
 *    return <>{page}{dialog}</>;
 *
 *  It resolves true on Confirm and false on Cancel, Escape or an outside click, and the dialog is a real modal:
 *  focus is trapped, then returned to the control that asked. */
export function useConfirmDialog() {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false); // a second request cancels the first
        resolver.current = resolve;
        setOpen(options);
      }),
    [],
  );
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(null);
  };

  const dialog = open ? (
    <ConfirmDialog title={open.title} confirmLabel={open.confirmLabel} tone={open.tone ?? "default"} onConfirm={() => settle(true)} onCancel={() => settle(false)}>
      <p>{open.body}</p>
    </ConfirmDialog>
  ) : null;
  return { confirm, dialog };
}
