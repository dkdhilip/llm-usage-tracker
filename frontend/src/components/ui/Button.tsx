import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-brand-600 bg-brand-600 text-white hover:border-brand-700 hover:bg-brand-700",
  secondary: "border-control bg-surface text-fg hover:bg-fill",
  ghost: "border-transparent bg-transparent text-fg-muted hover:bg-fill hover:text-fg",
  danger: "border-danger-line bg-surface text-danger-fg hover:bg-danger-soft",
  // the confirming action of an irreversible choice: solid red, white text (4.8:1)
  destructive: "border-red-600 bg-red-600 text-white hover:border-red-700 hover:bg-red-700",
};

// every size is at least 28px tall: above the 24px minimum target of WCAG 2.2 (2.5.8)
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 min-w-7 px-2.5 text-ui",
  md: "h-8 min-w-8 px-3 text-sm",
  lg: "h-11 px-4 text-base",
};
const ICON_SIZE: Record<ButtonSize, string> = { sm: "h-7 w-7", md: "h-8 w-8", lg: "h-11 w-11" };

/** The classes of a button, for the rare element that must look like one but is not a <button> (a link). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return cn(BASE, VARIANT[variant], SIZE[size], extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", type = "button", className, ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
});

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
  /** What the button does. Required: an icon alone is not a name. Also shown as the tooltip. */
  label: string;
  children: React.ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", type = "button", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(BASE, VARIANT[variant], ICON_SIZE[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
});
