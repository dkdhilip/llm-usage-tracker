import * as RD from "@radix-ui/react-dialog";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { IconButton } from "./Button";
import { XIcon } from "./icons";

export const Dialog = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;

type ContentProps = Omit<ComponentPropsWithoutRef<typeof RD.Content>, "title"> & {
  /** The dialog's visible heading; it is also its accessible name. */
  title: string;
  description?: ReactNode;
  /** "danger" tints the header for an action that cannot be undone. */
  tone?: "default" | "danger";
  /** "right" makes it a full-height side sheet (a detail panel); the default is a centred dialog. */
  placement?: "center" | "right";
  /** Show a Close (x) button in the header. Confirmation dialogs leave it out: they have Cancel. */
  showClose?: boolean;
  footer?: ReactNode;
};

/** A modal dialog on Radix: focus moves in and is trapped, Escape and an outside click close it, focus returns to
 *  what opened it, and the page behind is inert. Pass role="alertdialog" for a confirmation. */
export function DialogContent({ title, description, tone = "default", placement = "center", showClose = true, footer, className, children, onCloseAutoFocus, ...rest }: ContentProps) {
  // What had focus when the dialog opened. Radix returns focus only to a <Dialog.Trigger>, but confirmations are
  // opened from async handlers (no trigger), so remember the opener and hand focus back to it on close.
  const [opener] = useState(() => (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null));
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <RD.Content
        className={cn(
          "fixed z-50 flex flex-col bg-surface shadow-xl focus:outline-none",
          placement === "right"
            ? "inset-y-0 right-0 w-full max-w-lg border-l border-line"
            : "left-1/2 top-1/2 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border",
          placement === "center" && (tone === "danger" ? "border-danger-line" : "border-line"),
          className,
        )}
        // without a description, say so explicitly (Radix otherwise warns about a missing aria-describedby)
        {...(description ? {} : { "aria-describedby": undefined })}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          if (opener && opener !== document.body && opener.isConnected) opener.focus();
        }}
        {...rest}
      >
        <div className={cn("flex items-start justify-between gap-3 px-4 py-3", placement === "center" ? "rounded-t-lg border-b" : "border-b border-line", tone === "danger" ? "border-danger-line bg-danger-soft" : "border-line")}>
          <RD.Title className={cn("text-sm font-semibold", tone === "danger" ? "text-danger-fg" : "text-fg")}>{title}</RD.Title>
          {showClose && (
            <RD.Close asChild>
              <IconButton label="Close" size="sm" className={tone === "danger" ? "text-danger-fg" : undefined}>
                <XIcon />
              </IconButton>
            </RD.Close>
          )}
        </div>
        {description && (
          <RD.Description asChild>
            <div className="px-4 pt-3 text-sm text-fg-muted">{description}</div>
          </RD.Description>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-4 pb-4 pt-2">{footer}</div>}
      </RD.Content>
    </RD.Portal>
  );
}
