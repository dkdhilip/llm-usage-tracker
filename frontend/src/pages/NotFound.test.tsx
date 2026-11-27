import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { ThemeProvider } from "../lib/theme";
import { NotFound } from "./NotFound";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    authenticated: true, inWorkspace: true, isWorkspaceAdmin: true, loading: false, connectionError: false,
    workspace: { name: "Acme" }, refresh: vi.fn(),
  }),
}));

describe("an address with no page", () => {
  it("says so, with one h1 and a way back to the dashboard", () => {
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("is what the app shows for an unknown address, instead of quietly landing on the dashboard", () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/no/such/page"]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(document.title).toBe("Page not found · LLM Usage Tracker");
  });
});
