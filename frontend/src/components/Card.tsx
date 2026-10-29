import type { ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  className = "",
  level = 2,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** the heading level of the title: 2 under a page's own h1, 1 when the card is the whole page's content */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div
      className={`rounded-xl border border-line bg-surface shadow-sm ${className}`}
    >
      {(title || right) && (
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          {title && (
            <Heading className="text-sm font-semibold text-fg">{title}</Heading>
          )}
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}
