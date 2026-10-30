import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { IconButton } from "./ui/Button";
import { Logo } from "./ui/Logo";

const APP_NAME = "LLM Usage Tracker";
const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/requests": "Requests",
  "/playground": "Playground",
  "/workspace": "Workspace",
  "/account": "Account",
  "/login": "Sign in",
  "/welcome": "Get started",
  "/styleguide": "Design system",
};

const linkBase = "px-3 py-1.5 rounded-md text-sm font-medium transition-colors";

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? `${linkBase} bg-brand-600 text-white`
    : `${linkBase} text-fg-muted hover:bg-fill`;
}

function ThemeToggle() {
  const { isDark, toggle } = useTheme();
  return (
    <IconButton label="Toggle theme" title={isDark ? "Switch to light mode" : "Switch to dark mode"} variant="secondary" className="ml-1" onClick={toggle}>
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </IconButton>
  );
}

/** The links this visitor can use: just "Sign in" before signing in, then "Get started" until they are in a
 *  workspace, then the app pages (admins also get Requests, Playground and Workspace). */
function useNavLinks(): { to: string; label: string }[] {
  const { authenticated, inWorkspace, isWorkspaceAdmin } = useAuth();
  if (!authenticated) return [{ to: "/login", label: "Sign in" }];
  if (!inWorkspace) {
    return [
      { to: "/welcome", label: "Get started" },
      { to: "/account", label: "Account" },
    ];
  }
  return [
    { to: "/dashboard", label: "Dashboard" },
    ...(isWorkspaceAdmin
      ? [
          { to: "/requests", label: "Requests" },
          { to: "/playground", label: "Playground" },
          { to: "/workspace", label: "Workspace" },
        ]
      : []),
    { to: "/account", label: "Account" },
  ];
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { workspace } = useAuth();
  const links = useNavLinks();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  // one link ("Sign in") always fits beside the logo; more than that collapse into a menu on a narrow screen
  const collapses = links.length > 1;

  useEffect(() => setMenuOpen(false), [pathname]); // going to a page closes the menu

  // Every page has its own title (shown in the tab and read by a screen reader), and a route change is announced and
  // moves focus to the page, as a full page load would. The first render is left alone: the browser already did it.
  const pageTitle = PAGE_TITLES[pathname];
  const main = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${APP_NAME}` : APP_NAME;
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    setAnnouncement(pageTitle ?? APP_NAME);
    main.current?.focus({ preventScroll: true });
  }, [pathname, pageTitle]);
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus(); // keyboard users land back on the button that opened the menu
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [menuOpen]);

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-control focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg focus:shadow-md"
      >
        Skip to main content
      </a>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Logo />
            <span className="truncate font-semibold text-fg">{APP_NAME}</span>
            {workspace && (
              <span className="hidden max-w-[10rem] shrink-0 truncate rounded bg-fill px-1.5 py-0.5 text-xs text-fg-muted sm:inline-block">
                {workspace.name}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <nav aria-label="Main" className={`items-center gap-1 ${collapses ? "hidden md:flex" : "flex"}`}>
              {links.map((l) => (
                <NavLink key={l.to} to={l.to} className={navClass}>
                  {l.label}
                </NavLink>
              ))}
            </nav>
            <ThemeToggle />
            {collapses && (
              <IconButton
                ref={menuButton}
                label="Menu"
                title={menuOpen ? "Close menu" : "Open menu"}
                variant="secondary"
                aria-expanded={menuOpen}
                aria-controls="mobile-nav"
                onClick={() => setMenuOpen((o) => !o)}
                className="ml-1 md:hidden"
              >
                <MenuIcon open={menuOpen} />
              </IconButton>
            )}
          </div>
        </div>
        {collapses && menuOpen && (
          <nav id="mobile-nav" aria-label="Main menu" className="border-t border-line md:hidden">
            <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-2">
              {workspace && <div className="px-3 py-1 text-xs text-fg-muted">Workspace: {workspace.name}</div>}
              {links.map((l) => (
                <NavLink key={l.to} to={l.to} className={(s) => `${navClass(s)} block py-2.5`}>
                  {l.label}
                </NavLink>
              ))}
            </div>
          </nav>
        )}
      </header>

      <main id="main" ref={main} tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
