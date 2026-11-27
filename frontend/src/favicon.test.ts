import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(at("../index.html"), "utf8");

describe("the tab icon", () => {
  it("is linked with a version, so a browser that cached the old icon fetches the new one", () => {
    const svg = html.match(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=(\d+)"/);
    const ico = html.match(/<link rel="icon" href="\/favicon\.ico\?v=(\d+)" sizes="32x32"/);
    expect(svg).not.toBeNull();
    expect(ico).not.toBeNull();
    expect(svg![1]).toBe(ico![1]); // both move together
  });

  it("exists as an SVG and as a real .ico (not the app's HTML page)", () => {
    expect(existsSync(at("../public/favicon.svg"))).toBe(true);
    const ico = readFileSync(at("../public/favicon.ico"));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]); // ICO header: reserved 0, type 1 (icon)
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });
});
