import { useState, type ReactNode } from "react";
import { Card } from "../components/Card";
import { CostCell } from "../components/CostCell";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button, IconButton, type ButtonSize, type ButtonVariant } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, CopyIcon, MoreIcon, RefreshIcon, SearchIcon, XIcon } from "../components/ui/icons";
import { InlineAlert } from "../components/ui/InlineAlert";
import { PageHeader } from "../components/ui/PageHeader";
import { ScrollRegion } from "../components/ui/ScrollRegion";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Skeleton } from "../components/ui/Skeleton";
import { PROVIDER_COLORS } from "../lib/chartColors";
import { providerName } from "../lib/format";

/** The design system on one page: tokens and shared components, in the current theme (use the moon/sun button to
 *  compare light and dark). Only built into the app when VITE_STYLEGUIDE=1 (the UI audit environment and local work). */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card title={title}>
      {note && <p className="mb-3 text-sm text-fg-muted">{note}</p>}
      {children}
    </Card>
  );
}

const SWATCHES: { name: string; cls: string; use: string }[] = [
  { name: "surface", cls: "bg-surface border border-line", use: "cards, panels" },
  { name: "surface-2", cls: "bg-surface-2 border border-line", use: "page, field fill" },
  { name: "fill", cls: "bg-fill border border-line", use: "chips, hover" },
  { name: "line", cls: "bg-line", use: "decorative borders" },
  { name: "control", cls: "bg-control", use: "control boundary (3:1)" },
  { name: "brand-600", cls: "bg-brand-600", use: "primary action" },
  { name: "brand-text", cls: "bg-brand-text", use: "links, brand text" },
  { name: "success-fg / soft", cls: "bg-success-soft text-success-fg border border-success-line", use: "success" },
  { name: "warning-fg / soft", cls: "bg-warning-soft text-warning-fg border border-warning-line", use: "warning, no price" },
  { name: "danger-fg / soft", cls: "bg-danger-soft text-danger-fg border border-danger-line", use: "error, revoke" },
  { name: "info-fg / soft", cls: "bg-info-soft text-info-fg border border-info-line", use: "info, selected" },
];

const TYPE: { cls: string; name: string }[] = [
  { cls: "text-page font-semibold", name: "page 28/36 · page title" },
  { cls: "text-kpi-lg font-semibold", name: "kpi-lg 36/44 · cost KPI" },
  { cls: "text-kpi font-semibold", name: "kpi 28/36 · KPI" },
  { cls: "text-title font-semibold", name: "title 20/28 · section" },
  { cls: "text-base", name: "base 16/24 · reading text" },
  { cls: "text-sm", name: "sm 14/20 · body" },
  { cls: "text-ui", name: "ui 13/18 · controls, secondary" },
  { cls: "text-xs", name: "xs 12/16 · meta" },
  { cls: "text-meta uppercase tracking-wide", name: "meta 11/16 · overline labels and IDs only" },
];

export function StyleGuide() {
  const [range, setRange] = useState("30d");
  const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
  const sizes: ButtonSize[] = ["sm", "md", "lg"];
  const badges: BadgeVariant[] = ["neutral", "brand", "success", "warning", "danger"];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Design system"
        description="Tokens and shared components in the current theme. Toggle light and dark with the button in the header."
        actions={<Button variant="secondary"><RefreshIcon /> Example action</Button>}
      />

      <Section title="Colour roles" note="Text pairs are at least 4.5:1, control boundaries 3:1, in both themes.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {SWATCHES.map((s) => (
            <div key={s.name} className="rounded-md">
              <div className={`h-12 rounded-md ${s.cls}`} />
              <p className="mt-1 text-ui font-medium text-fg">{s.name}</p>
              <p className="text-xs text-fg-muted">{s.use}</p>
            </div>
          ))}
        </div>
        <h3 className="mb-2 mt-5 text-ui font-semibold text-fg">Provider colours (charts)</h3>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {Object.entries(PROVIDER_COLORS).map(([p, c]) => (
            <li key={p} className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: c }} /> {providerName(p)} <span className="font-mono text-xs text-fg-subtle">{c}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Type scale" note="Metadata may be small (11 to 12px) but always keeps AA contrast.">
        <ul className="space-y-2">
          {TYPE.map((t) => (
            <li key={t.name} className="flex flex-wrap items-baseline gap-x-4">
              <span className={`${t.cls} text-fg`}>$0.9643 Aa</span>
              <span className="text-xs text-fg-muted">{t.name}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Buttons" note="Every size is at least 28px tall (the WCAG 2.2 minimum target is 24px). Icon-only buttons require a label.">
        <div className="space-y-3">
          {sizes.map((size) => (
            <div key={size} className="flex flex-wrap items-center gap-2">
              <span className="w-10 text-xs text-fg-muted">{size}</span>
              {variants.map((v) => <Button key={v} variant={v} size={size}>{v}</Button>)}
              <Button size={size} disabled>disabled</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-10 text-xs text-fg-muted">icon</span>
            <IconButton label="Previous request"><ArrowUpIcon /></IconButton>
            <IconButton label="Next request"><ArrowDownIcon /></IconButton>
            <IconButton label="Back to requests"><ArrowLeftIcon /></IconButton>
            <IconButton label="Copy prompt" variant="secondary"><CopyIcon /></IconButton>
            <IconButton label="More actions for prod-openai" variant="secondary"><MoreIcon /></IconButton>
            <IconButton label="Search" variant="secondary"><SearchIcon /></IconButton>
            <IconButton label="Close inspector" size="sm"><XIcon /></IconButton>
          </div>
        </div>
      </Section>

      <Section title="Fields" note="A visible 3:1 boundary and a focus ring. The label, hint and error are wired to the control.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Label" hint="Each key needs its own name.">{(c) => <Input {...c} placeholder="e.g. Support Bot" />}</Field>
          <Field label="Monthly budget (USD)" error="Enter a number of 0 or more.">{(c) => <Input {...c} type="number" defaultValue="-1" />}</Field>
          <Field label="Provider">{(c) => <Select {...c} defaultValue="openai"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></Select>}</Field>
          <Field label="Prompt">{(c) => <Textarea {...c} defaultValue="In two sentences, explain what an LLM gateway does." />}</Field>
          <Field label="Disabled">{(c) => <Input {...c} disabled defaultValue="vk_…" />}</Field>
        </div>
      </Section>

      <Section title="Segmented control and badges">
        <div className="space-y-4">
          <SegmentedControl label="Time range" value={range} onChange={setRange} options={[{ value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "all", label: "All" }]} />
          <div className="flex flex-wrap items-center gap-2">
            {badges.map((b) => <Badge key={b} variant={b} dot>{b}</Badge>)}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">Priced <CostCell cost={0.3778} requests={88} unpriced={0} /></span>
            <span className="flex items-center gap-2">Partly priced <CostCell cost={0.007} requests={20} unpriced={9} /></span>
            <span className="flex items-center gap-2">No price <CostCell cost={0} requests={54} unpriced={54} /></span>
            <span className="flex items-center gap-2">Free <CostCell cost={0} requests={22} unpriced={0} /></span>
          </div>
        </div>
      </Section>

      <Section title="Alerts and states" note="An error is announced at once (role=alert); the others politely (role=status).">
        <div className="space-y-3">
          <InlineAlert tone="error" title="Couldn't load usage" action={<Button size="sm">Retry</Button>}>database unavailable</InlineAlert>
          <InlineAlert tone="warning" title="63 requests have no price yet">The real total is higher than shown.</InlineAlert>
          <InlineAlert tone="info">Stored content is deleted after 30 days.</InlineAlert>
          <InlineAlert tone="success">Key created. Copy it now: it is shown once.</InlineAlert>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-line p-3"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-9 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
            <div className="rounded-md border border-line"><EmptyState title="No requests yet" description="Point your app at the gateway and its calls show up here." action={<Button variant="primary">Connect your app</Button>} /></div>
          </div>
        </div>
      </Section>

      <Section title="Scroll region" note="A wide table scrolls inside its card. The region is named and reachable by keyboard.">
        <ScrollRegion label="Example table">
          <table className="w-full min-w-[40rem] text-sm">
            <thead><tr className="border-b border-line text-left text-meta uppercase tracking-wide text-fg-muted"><th className="py-2 pr-4">Key</th><th className="py-2 pr-4 text-right">Requests</th><th className="py-2 pr-4 text-right">Tokens</th><th className="py-2 text-right">Cost</th></tr></thead>
            <tbody><tr className="border-b border-line"><td className="py-2 pr-4">prod-openai</td><td className="py-2 pr-4 text-right">88</td><td className="py-2 pr-4 text-right">195.4K</td><td className="py-2 text-right"><CostCell cost={0.3778} requests={88} unpriced={0} /></td></tr></tbody>
          </table>
        </ScrollRegion>
      </Section>
    </div>
  );
}
