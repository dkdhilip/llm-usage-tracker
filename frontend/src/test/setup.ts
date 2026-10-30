import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom lacks a few browser APIs that Radix and cmdk rely on.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// Radix's popover positions itself with floating-ui, which needs real layout and hangs under jsdom. Unit tests use a
// small stand-in so they exercise the Combobox's own behaviour; placement, Escape and focus return are checked in a
// real browser by the UI audit harness (scripts/ui-audit). Radix's Dialog works under jsdom and is used as is.
vi.mock("@radix-ui/react-popover", () => import("./popoverMock"));

// The same goes for the menu of actions (a key's "⋯" menu).
vi.mock("@radix-ui/react-dropdown-menu", () => import("./dropdownMock"));
