import { cn } from "../../lib/cn";

/** The product mark: three rising bars (usage, measured) and a spark (the AI models being measured), white on the brand
 *  tile. Decorative (the name is always beside it), so it is hidden from assistive technology. Keep it in step with
 *  public/favicon.svg. */
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
      <g fill="#fff">
        <rect x="4" y="15" width="4" height="5" rx="1.5" />
        <rect x="9.4" y="12" width="4" height="8" rx="1.5" />
        <rect x="14.8" y="9" width="4" height="11" rx="1.5" />
        <path d="M18.2 2.6L19.1 4.5L21 5.4L19.1 6.3L18.2 8.2L17.3 6.3L15.4 5.4L17.3 4.5Z" />
      </g>
    </svg>
  );
}
