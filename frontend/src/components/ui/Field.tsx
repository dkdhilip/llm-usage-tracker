import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

// the boundary uses the `control` role (3:1); the field fill is the page colour so a field reads as an input
const CONTROL =
  "w-full rounded-md border border-control bg-surface-2 px-2.5 text-sm text-fg placeholder:text-fg-subtle " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger-line";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn("h-8", CONTROL, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn("h-8 pr-6", CONTROL, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn("min-h-20 py-2", CONTROL, className)} {...rest} />;
});

/** What a control needs to be wired to its label, hint and error. Spread it onto the Input/Select/Textarea. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** A labelled field: the label is associated with the control, and the hint and error are announced with it
 *  (aria-describedby). An error also marks the control invalid and is announced when it appears. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-ui font-medium text-fg">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
      {hint && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
