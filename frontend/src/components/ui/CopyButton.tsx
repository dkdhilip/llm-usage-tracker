import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { CheckIcon, CopyIcon } from "./icons";

/** Copies text to the clipboard. The button says "Copied" (and a polite live region announces it) for a moment; if the
 *  browser refuses (no clipboard access), it says so instead of pretending. */
export function CopyButton({
  label,
  what,
  text,
  variant = "secondary",
}: {
  /** the button's text, e.g. "Copy prompt" */
  label: string;
  /** what was copied, for the announcement, e.g. "Prompt" */
  what: string;
  text: string;
  variant?: "secondary" | "ghost";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  };

  return (
    <>
      <Button size="sm" variant={variant} onClick={copy}>
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? `${what} copied` : state === "failed" ? `Could not copy ${what.toLowerCase()}` : ""}
      </span>
    </>
  );
}
