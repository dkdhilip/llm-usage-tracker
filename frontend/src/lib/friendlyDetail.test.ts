import { afterEach, describe, expect, it, vi } from "vitest";
import { api, friendlyDetail } from "./api";

const mismatch = [
  {
    type: "string_pattern_mismatch",
    loc: ["body", "username"],
    msg: "String should match pattern '^[A-Za-z0-9]...'",
    input: "dhilip@gmail.com",
    ctx: { pattern: "^[A-Za-z0-9]..." },
  },
];

describe("friendlyDetail", () => {
  it("turns the username pattern error into a plain sentence (no JSON, no regex)", () => {
    const msg = friendlyDetail(mismatch);
    expect(msg).toMatch(/Username can only use letters, digits/);
    expect(msg).toMatch(/not an email/);
    expect(msg).not.toMatch(/[\[\]{}"]|pattern|body/);
  });

  it("explains a short password", () => {
    expect(friendlyDetail([{ type: "string_too_short", loc: ["body", "password"], msg: "too short" }])).toBe(
      "Password must be at least 8 characters.",
    );
  });

  it("names the field for other validation errors and merges duplicates", () => {
    const msg = friendlyDetail([
      { type: "missing", loc: ["body", "invite_code"], msg: "Field required" },
      { type: "missing", loc: ["body", "invite_code"], msg: "Field required" },
    ]);
    expect(msg).toBe("Invite code: Field required");
  });

  it("leaves plain string errors alone and still handles odd shapes", () => {
    expect(friendlyDetail("sign in required")).toBe("sign in required");
    expect(friendlyDetail({ message: "x" })).toBe('{"message":"x"}');
    expect(friendlyDetail([])).toBe("[]");
  });
});

describe("a rejected sign-up request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces the readable message, not raw JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: mismatch }), { status: 422, headers: { "Content-Type": "application/json" } })),
    );
    await expect(api.signup("dhilip@gmail.com", "password1")).rejects.toThrow(/Username can only use letters, digits/);
  });
});
