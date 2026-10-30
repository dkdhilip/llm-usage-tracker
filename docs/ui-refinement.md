# UI refinement: decisions and plan

Frontend-only programme to bring the interface to a consistent, accessible, observability-grade standard. No backend or API behaviour changes. Each phase is its own pull request, gated by the UI audit harness (`frontend/scripts/ui-audit`).

## Decisions

**Component foundations: Radix primitives, not the shadcn CLI.** The behaviours that are error-prone to hand-roll (modal dialog and drawer focus handling, dropdown menu, tabs, popover and searchable combobox) use `@radix-ui/react-dialog`, `-dropdown-menu`, `-tabs`, `-popover` and `cmdk`, wrapped in our own components on our own tokens. Everything else (Button, Field, Badge, Table, Skeleton, EmptyState, InlineAlert, icons) is plain React and Tailwind.

Why not the shadcn CLI (v4.23, tested on a copy): `shadcn init` rewrites `index.css` with Tailwind 4 only directives (`@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, a Geist font import), after which the build fails on this project's Tailwind 3.4. Moving to Tailwind 4 is a separate, larger change and is not part of this work. It also requires an `@/` import alias and brings `lucide-react` and a different theme.

**Bundle cost (gzip, measured on a copy):** baseline 184 KB; Dialog +13, Tabs +9, Popover +23, Menu +30 (shared positioning code overlaps); all five together **+37 KB (221 KB)**. Budget: at most +40 KB. Phase 7 added route-level code splitting (see Outcome).

**Not used:** Magic UI (landing-page effects: gradients, particles, shimmer; against the product's design rules).

## Rules for the work

Keep the identity (slate neutrals, indigo accent, subtle borders, cards). No decorative gradients or animation. Cost and usage are visually prominent; an unknown price is never shown as zero or free. WCAG 2.2 AA is the target (target size 24px with the standard's exceptions; keyboard and focus behaviour are checked by hand-written tests, not only by axe).

## Phases

0 harness and decisions · 1 tokens and primitives · 2 interaction and accessibility layer (dialogs, announced errors, honest loading/error states, titles and skip link, combobox, target sizes) · 3 Dashboard · 4 Requests (split-pane inspector) · 5 Workspace (tabs, key table) · 6 Playground · 7 Account/Login/polish · 8 hardening.

Out of scope because it needs backend work: prompt preview column and search over content, period comparisons, export, per-request deep links.

## Outcome

Eight stacked branches (`ui/phase-0-harness` ... `ui/phase-8-hardening`), each gated by the harness. What it enforces now (`frontend/scripts/ui-audit/thresholds.json`, never loosen):

- **Accessibility:** axe (WCAG 2.0/2.1/2.2 A and AA plus best practice) reports 0 nodes on every page at 5 widths, light and dark, and on the open states (inspector, key menu, create-key drawer, Playground with a response). 0 controls without a name. Every control is at least 24px at every width (documented exceptions: inline text links, native checkbox and radio). Text-field boundaries are at least 3:1.
- **Behaviour (real Chrome):** keyboard tab stops all show a focus ring and are never covered; dialogs trap focus and return it; Escape closes; the Requests inspector (Enter, J/K, deep link `?r=`, phone detail with Back), the key menu, the create-key drawer, the model/key combobox, the Workspace tabs and the Playground flow are each exercised end to end.
- **Layout:** no sideways page scroll from 320 to 1440 px, at 200% text size on desktop, and with WCAG 1.4.12 text spacing applied.
- **Honest states:** a loading page is never "No usage"; a failed load says so with Retry; a network outage does not look like being signed out; an unknown price reads "No price yet", never $0 or Free.

**Bundle (gzip, measured):** `main` 189 KB in one file. Now the sign-in screen loads about 76 KB and each page loads on demand (Dashboard with the chart library 110 KB, Workspace 31 KB, Requests 7 KB, Playground 4 KB); all pages together are about 243 KB (+53 KB over `main`, which is above the +40 KB budget if read as a total, and well below it for first load).

**Backend:** no file under `backend/`, `.github/` or the Docker files differs from `main`.

**Known limitation (low priority):** with text enlarged to 200% on a tablet or phone width, the header does not collapse in time and the page scrolls sideways (text spacing and 400% zoom at 320 px are fine, and 200% text is fine on desktop). Phone and tablet polish was deliberately deprioritised.

**Known follow-ups (not done):** the Dockerfile base image and CI action majors (tracked separately); a Playwright e2e of the real provider call (providers are mocked in the harness); the harness runs locally, not in CI.
