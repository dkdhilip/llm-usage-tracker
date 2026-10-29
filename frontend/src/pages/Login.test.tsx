import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Login } from "./Login";
import { USERNAME_PATTERN, USERNAME_RULES } from "../lib/validation";

const signup = vi.fn();
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ login: vi.fn(), signup, authenticated: false, sessionExpired: false }),
}));

describe("Login / sign-up form", () => {
  it("tells people up front that the username is not an email, only when signing up", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.queryByTestId("username-rules")).toBeNull(); // sign-in: no hint needed
    await user.click(screen.getByText("New here? Create an account"));
    expect(screen.getByTestId("username-rules").textContent).toMatch(/an email address won't work/);
  });

  it("shows the error message from a rejected sign-up as plain text", async () => {
    signup.mockRejectedValue(new Error("Username can only use letters, digits, . _ - (3-32 characters, no spaces, and no @: it is not an email address)."));
    const user = userEvent.setup();
    render(<MemoryRouter><Login /></MemoryRouter>);
    await user.click(screen.getByText("New here? Create an account"));
    await user.type(screen.getByLabelText(/Username/), "dhilip.s");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(screen.getByText(/Username can only use letters/)).toBeTruthy());
  });

  it("gives the username box a pattern the browser can actually use, and says what it allows", () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    const box = screen.getByLabelText(/Username/);
    const pattern = box.getAttribute("pattern")!;
    // browsers compile `pattern` with the v flag: it must be valid there, or the check is silently dropped
    expect(() => new RegExp(`^(?:${pattern})$`, "v")).not.toThrow();
    expect(pattern).toBe(USERNAME_PATTERN);
    expect(box.getAttribute("title")).toBe(USERNAME_RULES);
    expect(box).toHaveAttribute("minlength", "3");
    expect(box).toHaveAttribute("maxlength", "32");
  });

  it("flags a name the server would reject, using the browser's own validity check", () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    const box = screen.getByLabelText(/Username/) as HTMLInputElement;
    for (const [name, ok] of [["dhilip.s", true], ["a-b", true], ["-ab", false], ["ab_", false], ["me@example.com", false], ["has space", false]] as const) {
      fireEvent.change(box, { target: { value: name } });
      // jsdom evaluates pattern like a browser does, but only with the u flag: both flags agree on this rule
      expect(box.validity.patternMismatch).toBe(!ok);
    }
  });
});
