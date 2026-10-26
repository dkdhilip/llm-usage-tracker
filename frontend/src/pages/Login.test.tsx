import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Login } from "./Login";

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
});
