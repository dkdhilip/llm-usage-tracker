import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDetail } from "../../lib/api";
import { ContentLoggingCard } from "./ContentLoggingCard";
import { SecretBox } from "./SecretBox";

vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: {} }));

const ws = (over: Partial<WorkspaceDetail> = {}): WorkspaceDetail => ({ id: 1, name: "Acme", role: "admin", ...over });

describe("ContentLoggingCard", () => {
  it("renders when the workspace's logging state arrives after the first render (no hook-order error)", () => {
    const { rerender } = render(<ContentLoggingCard ws={ws()} onChange={() => {}} />);
    expect(screen.queryByText("Prompt & response logging")).toBeNull(); // nothing to show yet
    rerender(
      <ContentLoggingCard
        ws={ws({ content_logging: { enabled: false, retention_days: 30, updated_at: null, keys_total: 1, keys_logging: 0, keys_logging_images: 0 } })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Prompt & response logging")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });
});

describe("SecretBox", () => {
  it("shows the value once, with a Copy button that names what it copies", () => {
    render(<SecretBox title="Copy this key now" value="vk_secret" what="Key" />);
    expect(screen.getByText("vk_secret")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
