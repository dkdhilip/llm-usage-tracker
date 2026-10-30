import { useEffect, useState } from "react";

const read = (query: string, fallback: boolean) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;

/** Whether a CSS media query matches, kept up to date. Used where one data set is drawn two ways (a table on a
 *  desktop, cards on a phone), so only one of them is in the page at a time. Without matchMedia (jsdom) it returns
 *  `fallback`, which is the desktop layout. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => read(query, fallback));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The phone layout of the design (below 700px). */
export const PHONE_QUERY = "(max-width: 699px)";
/** Wide enough for the list and the inspector side by side (1100px and up). */
export const SPLIT_QUERY = "(min-width: 1100px)";
