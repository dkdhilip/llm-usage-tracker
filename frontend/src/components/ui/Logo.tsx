import { cn } from "../../lib/cn";

/** The product mark: a gateway arch with a request passing through it (a gateway you can see into). Decorative (the
 *  name is always beside it), so it is hidden from assistive technology. Keep it in step with public/favicon.svg. */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <rect width="24" height="24" rx="6" className="fill-brand-600" />
      <path d="M6.5 18.5V12a5.5 5.5 0 0 1 11 0v6.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <circle cx="12" cy="13.2" r="2.1" fill="#fff" />
    </svg>
  );
}
