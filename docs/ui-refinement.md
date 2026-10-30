# UI refinement: decisions and plan

Frontend-only programme to bring the interface to a consistent, accessible, observability-grade standard. No backend or API behaviour changes. Each phase is its own pull request, gated by the UI audit harness (`frontend/scripts/ui-audit`).

## Decisions

**Component foundations: Radix primitives, not the shadcn CLI.** The behaviours that are error-prone to hand-roll (modal dialog and drawer focus handling, dropdown menu, tabs, popover and searchable combobox) use `@radix-ui/react-dialog`, `-dropdown-menu`, `-tabs`, `-popover` and `cmdk`, wrapped in our own components on our own tokens. Everything else (Button, Field, Badge, Table, Skeleton, EmptyState, InlineAlert, icons) is plain React and Tailwind.

Why not the shadcn CLI (v4.23, tested on a copy): `shadcn init` rewrites `index.css` with Tailwind 4 only directives (`@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, a Geist font import), after which the build fails on this project's Tailwind 3.4. Moving to Tailwind 4 is a separate, larger change and is not part of this work. It also requires an `@/` import alias and brings `lucide-react` and a different theme.

**Bundle cost (gzip, measured on a copy):** baseline 184 KB; Dialog +13, Tabs +9, Popover +23, Menu +30 (shared positioning code overlaps); all five together **+37 KB (221 KB)**. Budget: at most +40 KB. Route-level code splitting of the charts can offset this later.

**Not used:** Magic UI (landing-page effects: gradients, particles, shimmer; against the product's design rules).

## Rules for the work

Keep the identity (slate neutrals, indigo accent, subtle borders, cards). No decorative gradients or animation. Cost and usage are visually prominent; an unknown price is never shown as zero or free. WCAG 2.2 AA is the target (target size 24px with the standard's exceptions; keyboard and focus behaviour are checked by hand-written tests, not only by axe).

## Phases

0 harness and decisions · 1 tokens and primitives · 2 interaction and accessibility layer (dialogs, announced errors, honest loading/error states, titles and skip link, combobox, target sizes) · 3 Dashboard · 4 Requests (split-pane inspector) · 5 Workspace (tabs, key table) · 6 Playground · 7 Account/Login/polish · 8 hardening.

Out of scope because it needs backend work: prompt preview column and search over content, period comparisons, export, per-request deep links.
