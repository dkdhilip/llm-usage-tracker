// A stand-in for @radix-ui/react-popover in unit tests. Radix's popover positions itself with floating-ui, which needs
// real layout and hangs under jsdom, so tests exercise the Combobox's own behaviour (filtering, keyboard choice, naming)
// against this. What only a browser can show (placement, Escape, focus return) is checked by the UI audit harness.
import { cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

const Ctx = createContext<{ open: boolean; set: (o: boolean) => void }>({ open: false, set: () => {} });

export function Root({ open, defaultOpen = false, onOpenChange, children }: { open?: boolean; defaultOpen?: boolean; onOpenChange?: (o: boolean) => void; children: ReactNode }) {
  const [inner, setInner] = useState(defaultOpen);
  const value = open ?? inner;
  const set = (o: boolean) => {
    setInner(o);
    onOpenChange?.(o);
  };
  return <Ctx.Provider value={{ open: value, set }}>{children}</Ctx.Provider>;
}

export function Trigger({ asChild, children, ...props }: { asChild?: boolean; children: ReactNode }) {
  const { open, set } = useContext(Ctx);
  const common = { "aria-expanded": open, onClick: () => set(!open) };
  if (asChild && isValidElement(children)) return cloneElement(children as ReactElement<Record<string, unknown>>, common);
  return (
    <button type="button" {...props} {...common}>
      {children}
    </button>
  );
}

export const Portal = ({ children }: { children: ReactNode }) => <>{children}</>;

export function Content({ children, onOpenAutoFocus }: { children: ReactNode; onOpenAutoFocus?: (e: Event) => void; [k: string]: unknown }) {
  const { open, set } = useContext(Ctx);
  useEffect(() => {
    if (!open) return;
    onOpenAutoFocus?.(new Event("focus", { cancelable: true }));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return open ? <div data-testid="popover-content">{children}</div> : null;
}

export const Anchor = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Close = ({ children }: { children: ReactNode }) => <>{children}</>;
