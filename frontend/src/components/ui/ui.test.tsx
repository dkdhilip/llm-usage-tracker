import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge";
import { Button, IconButton, buttonClass } from "./Button";
import { EmptyState } from "./EmptyState";
import { Field, Input, Select, Textarea } from "./Field";
import { ArrowUpIcon } from "./icons";
import { InlineAlert } from "./InlineAlert";
import { PageHeader } from "./PageHeader";
import { ScrollRegion } from "./ScrollRegion";
import { SegmentedControl } from "./SegmentedControl";
import { Skeleton } from "./Skeleton";
import { cn } from "../../lib/cn";

// axe probes a canvas for icon fonts; jsdom has none and only logs a warning
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

// jsdom cannot compute colours, so contrast is checked in the browser audit; everything else is checked here
async function expectNoAxeViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}

describe("cn", () => {
  it("joins the truthy class names", () => {
    expect(cn("a", false, null, undefined, "b", 0 > 1 && "c")).toBe("a b");
  });
});

describe("Button", () => {
  it("is a button of type button by default and does not submit a form", async () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button>Cancel</Button></form>);
    const b = screen.getByRole("button", { name: "Cancel" });
    expect(b).toHaveAttribute("type", "button");
    await userEvent.click(b);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can be a submit button, and forwards its ref and disabled state", async () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} type="submit" disabled>Save</Button>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "Save" }));
    expect(ref.current).toBeDisabled();
  });

  it("is at least 28px tall at every size (WCAG 2.2 minimum target is 24px)", () => {
    expect(buttonClass("primary", "sm")).toContain("h-7");
    expect(buttonClass("secondary", "md")).toContain("h-8");
    expect(buttonClass("secondary", "lg")).toContain("h-11");
  });

  it("draws its boundary with the control role (3:1), not the decorative line", () => {
    expect(buttonClass("secondary")).toContain("border-control");
    expect(buttonClass("secondary")).not.toContain("border-line");
  });

  it("IconButton takes its accessible name and tooltip from `label`", () => {
    render(<IconButton label="Previous request"><ArrowUpIcon /></IconButton>);
    const b = screen.getByRole("button", { name: "Previous request" });
    expect(b).toHaveAttribute("title", "Previous request");
    expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<div><Button variant="primary">Save</Button><IconButton label="Close">x</IconButton></div>);
    await expectNoAxeViolations(container);
  });
});

describe("Field", () => {
  it("associates the label, the hint and the control", () => {
    render(<Field label="Label" hint="Each key needs its own name.">{(c) => <Input {...c} />}</Field>);
    const input = screen.getByLabelText("Label");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("Each key needs its own name.");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and announces the error", () => {
    render(<Field label="Budget" error="Enter a number of 0 or more.">{(c) => <Input {...c} />}</Field>);
    const input = screen.getByLabelText("Budget");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a number of 0 or more.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number of 0 or more.");
  });

  it("works with Select and Textarea, and gives each field its own id", () => {
    render(
      <div>
        <Field label="Provider">{(c) => <Select {...c}><option>OpenAI</option></Select>}</Field>
        <Field label="Prompt">{(c) => <Textarea {...c} />}</Field>
      </div>,
    );
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider").id).not.toBe(screen.getByLabelText("Prompt").id);
  });

  it("uses the control border and has no accessibility violations", async () => {
    const { container } = render(<Field label="Label" hint="hint" error="bad">{(c) => <Input {...c} />}</Field>);
    expect(screen.getByLabelText("Label").className).toContain("border-control");
    await expectNoAxeViolations(container);
  });
});

describe("Badge", () => {
  it("shows its text, with an optional dot that is hidden from assistive technology", () => {
    const { container } = render(<Badge variant="success" dot>Success</Badge>);
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
  it("maps each variant to a status role pair", () => {
    render(<div><Badge variant="warning">No price yet</Badge><Badge variant="danger">Error</Badge></div>);
    expect(screen.getByText("No price yet").className).toContain("bg-warning-soft");
    expect(screen.getByText("Error").className).toContain("text-danger-fg");
  });
});

describe("SegmentedControl", () => {
  const options = [{ value: "7d", label: "7d" }, { value: "30d", label: "30d" }];
  it("is a named group whose buttons expose which one is pressed", () => {
    render(<SegmentedControl label="Time range" options={options} value="30d" onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Time range" });
    expect(within(group).getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
  });
  it("reports the chosen value, from the keyboard too", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Time range" options={options} value="30d" onChange={onChange} />);
    screen.getByRole("button", { name: "7d" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("7d");
  });
});

describe("InlineAlert", () => {
  it("announces an error immediately and the other tones politely", () => {
    render(<div><InlineAlert tone="error">boom</InlineAlert><InlineAlert tone="info">fyi</InlineAlert></div>);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("status")).toHaveTextContent("fyi");
  });
  it("shows a title, a body and a recovery action", async () => {
    const retry = vi.fn();
    render(<InlineAlert title="Couldn't load" action={<Button onClick={retry}>Retry</Button>}>database unavailable</InlineAlert>);
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.getByText("database unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });
  it("lets the caller choose the role", () => {
    render(<InlineAlert tone="warning" role="note">careful</InlineAlert>);
    expect(screen.getByRole("note")).toHaveTextContent("careful");
  });
  it("has no accessibility violations", async () => {
    const { container } = render(<InlineAlert tone="error" title="Oops">detail</InlineAlert>);
    await expectNoAxeViolations(container);
  });
});

describe("PageHeader, EmptyState, Skeleton, ScrollRegion", () => {
  it("PageHeader renders the page's single h1, its description and actions", () => {
    render(<PageHeader title="Usage" description="Acme · 477 requests" actions={<Button>Refresh</Button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeInTheDocument();
    expect(screen.getByText("Acme · 477 requests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
  it("EmptyState says what is missing and offers the next step", () => {
    render(<EmptyState title="No requests yet" description="Point your app at the gateway." action={<Button>Connect</Button>} />);
    expect(screen.getByText("No requests yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
  it("Skeleton is hidden from assistive technology and stops animating for reduced motion", () => {
    const { container } = render(<Skeleton className="h-4" />);
    const el = container.firstElementChild!;
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.className).toContain("motion-reduce:animate-none");
  });
  it("ScrollRegion is a named region the keyboard can reach", () => {
    render(<ScrollRegion label="Requests table"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    const r = screen.getByRole("region", { name: "Requests table" });
    expect(r).toHaveAttribute("tabindex", "0");
    expect(r.className).toContain("relative");
  });
});
