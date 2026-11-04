import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { InfoIcon } from "./icons";

/** A small (i) button that explains something in plain words. The explanation shows when the pointer rests on it or
 *  the button has focus, and a tap or Enter toggles it (so it works on a touch screen and from the keyboard). Escape
 *  closes it, and moving the pointer onto the explanation keeps it open. The text is always attached to the button
 *  (aria-describedby), so a screen reader reads it too. The explanation is placed under the nearest positioned
 *  ancestor (put `relative` on the row that holds the button), so it can use the row's width and never runs off a
 *  narrow screen. */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false); // opened by a click or tap
  const [dismissed, setDismissed] = useState(false); // Escape closes it even while the pointer or focus is still there
  const wrap = useRef<HTMLSpanElement>(null);
  const open = !dismissed && (hover || focus || pinned);

  useEffect(() => {
    if (!open) return;
    // Escape closes the tip and goes no further: caught on the window, before a dialog around it can see it, so
    // the first Escape closes only the explanation and a second one closes the dialog.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setDismissed(true);
      setPinned(false);
    };
    const outside = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setPinned(false);
    };
    window.addEventListener("keydown", esc, true);
    document.addEventListener("mousedown", outside);
    return () => {
      window.removeEventListener("keydown", esc, true);
      document.removeEventListener("mousedown", outside);
    };
  }, [open]);

  return (
    <span ref={wrap} className={cn("inline-flex", className)} onMouseEnter={() => {
        setHover(true);
        setDismissed(false);
      }} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => {
          setDismissed(false);
          setPinned((p) => !p);
        }}
        onFocus={() => {
          setFocus(true);
          setDismissed(false);
        }}
        onBlur={() => setFocus(false)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-text"
      >
        <InfoIcon size={16} />
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          open
            ? "absolute left-0 top-full z-50 mt-1 block w-72 max-w-full rounded-md border border-line bg-surface p-3 text-left text-sm font-normal text-fg shadow-lg"
            : "sr-only",
        )}
      >
        {children}
      </span>
    </span>
  );
}
