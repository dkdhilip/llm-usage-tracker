import { cn } from "../../lib/cn";

/** The product mark: rising usage bars on the brand colour. Decorative (the name is always beside it), so it is
 *  hidden from assistive technology. */
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
      <path d="M7 17v-3M12 17V9M17 17V6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
