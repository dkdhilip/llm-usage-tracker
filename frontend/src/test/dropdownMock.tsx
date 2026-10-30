// A stand-in for @radix-ui/react-dropdown-menu in unit tests. Like the popover, Radix's menu positions itself with
// floating-ui, which needs real layout and hangs under jsdom. Tests exercise what the page does with the menu (which
// items exist, what choosing one does); the menu's own keyboard model, placement and focus return are checked in a
// real browser by the UI audit harness (scripts/ui-audit).
import { cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode } from "react";

type CloseHandler = ((e: Event) => void) | undefined;
const Ctx = createContext<{ open: boolean; set: (o: boolean) => void; onClose: MutableRefObject<CloseHandler> }>({
  open: false,
  set: () => {},
  onClose: { current: undefined },
});

export function Root({ children }: { children: ReactNode; modal?: boolean }) {
  const [open, set] = useState(false);
  const onClose = useRef<CloseHandler>(undefined);
  return <Ctx.Provider value={{ open, set, onClose }}>{children}</Ctx.Provider>;
}

export function Trigger({ asChild, children, ...props }: { asChild?: boolean; children: ReactNode }) {
  const { open, set } = useContext(Ctx);
  const common = { "aria-expanded": open, "aria-haspopup": "menu" as const, onClick: () => set(!open) };
  if (asChild && isValidElement(children)) return cloneElement(children as ReactElement<Record<string, unknown>>, common);
  return (
    <button type="button" {...props} {...common}>
      {children}
    </button>
  );
}

export const Portal = ({ children }: { children: ReactNode }) => <>{children}</>;

export function Content({ children, onCloseAutoFocus }: { children: ReactNode; onCloseAutoFocus?: CloseHandler; [k: string]: unknown }) {
  const { open, set, onClose } = useContext(Ctx);
  onClose.current = onCloseAutoFocus;
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, set]);
  return open ? (
    <div role="menu" data-testid="menu-content">
      {children}
    </div>
  ) : null;
}

export function Item({ onSelect, disabled, children, ...props }: { onSelect?: (e: Event) => void; disabled?: boolean; children: ReactNode; [k: string]: unknown }) {
  const { set, onClose } = useContext(Ctx);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      onClick={() => {
        if (disabled) return;
        onSelect?.(new Event("select"));
        set(false);
        // Radix hands focus back to the button once the menu has closed; the page can take that over
        queueMicrotask(() => onClose.current?.(new Event("closeautofocus", { cancelable: true })));
      }}
      {...(props as object)}
    >
      {children}
    </div>
  );
}

export const Separator = () => <hr />;
