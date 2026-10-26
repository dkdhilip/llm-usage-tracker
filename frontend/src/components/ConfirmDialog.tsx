import { useEffect, useRef, type ReactNode } from "react";

/** A red confirmation box for actions that cannot be undone from the UI. Escape or clicking outside cancels;
 *  focus starts on Cancel so a stray Enter never confirms. */
export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-lg border border-red-300 bg-surface shadow-xl dark:border-red-500/40"
      >
        <div className="rounded-t-lg border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-500/30 dark:bg-red-500/10">
          <h2 id="confirm-title" className="text-sm font-semibold text-red-700 dark:text-red-400">
            {title}
          </h2>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm text-fg-muted">{children}</div>
        {error && (
          <div role="alert" className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className="rounded border border-line px-3 py-1.5 text-sm text-fg-muted hover:bg-fill"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
