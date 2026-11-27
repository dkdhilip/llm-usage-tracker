import { describe, expect, it } from "vitest";
// read as text through Vite (the app's TypeScript has no Node types, so no node:fs here)
import html from "../index.html?raw";
import svg from "../public/favicon.svg?raw";
import ico from "../public/favicon.ico?raw";

describe("the tab icon", () => {
  it("is linked with a version, so a browser that cached the old icon fetches the new one", () => {
    const svgLink = html.match(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=(\d+)"/);
    const icoLink = html.match(/<link rel="icon" href="\/favicon\.ico\?v=(\d+)" sizes="32x32"/);
    expect(svgLink).not.toBeNull();
    expect(icoLink).not.toBeNull();
    expect(svgLink![1]).toBe(icoLink![1]); // both move together
  });

  it("exists as an SVG and as a real .ico (not the app's HTML page)", () => {
    expect(svg).toContain("<svg");
    // ICO header: reserved 0, type 1 (icon), then the number of images (little-endian)
    expect([0, 1, 2, 3].map((i) => ico.charCodeAt(i))).toEqual([0, 0, 1, 0]);
    expect(ico.charCodeAt(4) + 256 * ico.charCodeAt(5)).toBeGreaterThanOrEqual(1);
  });
});
