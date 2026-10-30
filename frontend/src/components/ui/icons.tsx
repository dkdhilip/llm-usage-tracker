import type { ReactNode, SVGProps } from "react";

/** A small inline icon set (no icon dependency). Icons are decorative: they are hidden from assistive technology,
 *  so the control that holds one must carry its own accessible name. */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function icon(paths: ReactNode, name: string) {
  const Icon = ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />, "ChevronDownIcon");
export const XIcon = icon(<path d="M18 6 6 18M6 6l12 12" />, "XIcon");
export const MoreIcon = icon(
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
  "MoreIcon",
);
export const CopyIcon = icon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </>,
  "CopyIcon",
);
export const CheckIcon = icon(<path d="m5 12 5 5 9-10" />, "CheckIcon");
export const ArrowUpIcon = icon(<path d="M12 19V5M5 12l7-7 7 7" />, "ArrowUpIcon");
export const ArrowDownIcon = icon(<path d="M12 5v14M19 12l-7 7-7-7" />, "ArrowDownIcon");
export const ArrowLeftIcon = icon(<path d="M19 12H5M12 19l-7-7 7-7" />, "ArrowLeftIcon");
export const RefreshIcon = icon(<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />, "RefreshIcon");
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
  "SearchIcon",
);
export const AlertIcon = icon(
  <>
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17.5v.01" />
  </>,
  "AlertIcon",
);
export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8v.01" />
  </>,
  "InfoIcon",
);
