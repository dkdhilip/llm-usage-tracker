import * as DM from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { pageContainer } from "../../lib/portal";
import { IconButton } from "./Button";
import { MoreIcon } from "./icons";

/** A menu of actions for one thing (a key's Revoke, Delete, ...). Radix gives it the menu keyboard model: Enter or
 *  Arrow Down opens it, Arrow keys and typing move, Enter chooses, Escape closes and returns focus to the button.
 *  It is not modal: the page behind stays in the accessibility tree (a menu is not a dialog), and an action that
 *  opens a dialog can do so once the menu has closed. */
export function Menu(props: ComponentPropsWithoutRef<typeof DM.Root>) {
  return <DM.Root modal={false} {...props} />;
}

/** The "⋯" button. Name it for what the menu acts on ("More actions for prod-openai"), so a list of them is not a
 *  list of identical buttons. */
export const MenuButton = forwardRef<HTMLButtonElement, { label: string }>(function MenuButton({ label }, ref) {
  return (
    <DM.Trigger asChild>
      <IconButton ref={ref} label={label} size="sm" variant="secondary" aria-haspopup="menu">
        <MoreIcon />
      </IconButton>
    </DM.Trigger>
  );
});

export function MenuList({
  children,
  className,
  onCloseAutoFocus,
}: {
  children: ReactNode;
  className?: string;
  /** runs when the menu has closed and would hand focus back to its button; preventDefault() to take over */
  onCloseAutoFocus?: ComponentPropsWithRef<typeof DM.Content>["onCloseAutoFocus"];
}) {
  return (
    <DM.Portal container={pageContainer()}>
      <DM.Content
        align="end"
        sideOffset={4}
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn("z-50 min-w-[12rem] rounded-md border border-line bg-surface p-1 shadow-lg focus:outline-none", className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  tone,
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof DM.Item> & { tone?: "danger" }) {
  return (
    <DM.Item
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center rounded px-2.5 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-fill data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        tone === "danger" ? "text-danger-fg" : "text-fg",
        className,
      )}
      {...rest}
    />
  );
}

export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-line" />;
