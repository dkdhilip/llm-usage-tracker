import { describe, expect, it } from "vitest";
import { USERNAME_PATTERN } from "./validation";

// the server's own rule, copied from backend/app/routers/auth.py
const SERVER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/;
// how a browser applies an input's `pattern`: anchored, compiled with the v flag (and u, as older browsers do)
const asInput = (flags: string) => new RegExp(`^(?:${USERNAME_PATTERN})$`, flags);

const CASES = [
  "abc", "ab", "a", "", "a-b", "a.b", "a_b", "-ab", "ab-", ".ab", "ab.", "_ab", "ab_",
  "john.doe", "john_doe-99", "Sam", "x".repeat(32), "x".repeat(33), "has space", "me@example.com",
  "ünï", "a--b", "a..b", "0a0",
];

describe("USERNAME_PATTERN", () => {
  it("is a valid pattern in both the u and the v regex modes (the old one was not valid in v)", () => {
    expect(() => asInput("v")).not.toThrow();
    expect(() => asInput("u")).not.toThrow();
    expect(() => new RegExp("[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]", "v")).toThrow(); // the bug this fixes
  });

  it.each(CASES)("accepts exactly what the server accepts: %j", (name) => {
    const server = SERVER.test(name);
    expect(asInput("v").test(name)).toBe(server);
    expect(asInput("u").test(name)).toBe(server);
  });
});
