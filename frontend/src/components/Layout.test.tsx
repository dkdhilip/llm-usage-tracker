import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";
import { ThemeProvider } from "../lib/theme";

type Who = { authenticated: boolean; inWorkspace: boolean; isWorkspaceAdmin: boolean; workspace: { name: string } | null };
let who: Who;
vi.mock("../lib/auth", () => ({ useAuth: () => who }));

const ADMIN: Who = { authenticated: true, inWorkspace: true, isWorkspaceAdmin: true, workspace: { name: "Acme Audit" } };

const show = (w: Who, path = "/dashboard") => {
  who = w;
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Layout>
          <p>page</p>
        </Layout>
      </MemoryRouter>
    </ThemeProvider>,
  );
};

beforeEach(() => {
  who = ADMIN;
});

describe("Layout navigation on a narrow screen", () => {
  it("has a Menu button that is closed at first and opens a list of every page", async () => {
    show(ADMIN);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Main menu" })).toBeNull();

    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual([
      "Dashboard", "Requests", "Playground", "Workspace", "Account",
    ]);
    expect(within(nav).getByText("Workspace: Acme Audit")).toBeTruthy(); // the name the header chip hides on a phone
  });

  it("marks the current page, and closes when a page is chosen", async () => {
    show(ADMIN, "/requests");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("link", { name: "Account" }));
    expect(screen.queryByRole("navigation", { name: "Main menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes with Escape and toggles with the same button, both from the keyboard", async () => {
    show(ADMIN);
    const menu = screen.getByRole("button", { name: "Menu" });
    menu.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("navigation", { name: "Main menu" })).toBeTruthy();
    await userEvent.tab(); // into the first link of the open menu
    expect(screen.getByRole("navigation", { name: "Main menu" }).contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "Main menu" })).toBeNull();
    expect(menu).toHaveFocus(); // focus goes back to the Menu button
    await userEvent.keyboard("{Enter}");
    await userEvent.click(menu);
    expect(screen.queryByRole("navigation", { name: "Main menu" })).toBeNull();
  });

  it("keeps the theme switch in the header, outside the menu, at every width", () => {
    show(ADMIN);
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeTruthy();
  });

  it("gives a Team Member only the pages they can use", async () => {
    show({ ...ADMIN, isWorkspaceAdmin: false });
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Dashboard", "Account"]);
  });

  it("keeps a lone Sign in link in the header (no menu needed) before signing in", () => {
    show({ authenticated: false, inWorkspace: false, isWorkspaceAdmin: false, workspace: null }, "/login");
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("offers Get started and Account (in the menu) to someone who has not joined a workspace", async () => {
    show({ authenticated: true, inWorkspace: false, isWorkspaceAdmin: false, workspace: null }, "/welcome");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Get started", "Account"]);
  });
});
