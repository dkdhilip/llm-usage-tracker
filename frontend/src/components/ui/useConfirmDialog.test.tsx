import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "./useConfirmDialog";

function Demo({ onResult, tone }: { onResult: (ok: boolean) => void; tone?: "danger" | "default" }) {
  const { confirm, dialog } = useConfirmDialog();
  return (
    <>
      <button onClick={async () => onResult(await confirm({ title: "Delete it?", body: "This cannot be undone.", confirmLabel: "Delete", tone }))}>Ask</button>
      <button>Other</button>
      {dialog}
    </>
  );
}

const ask = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Ask" }));
  return screen.findByRole("alertdialog");
};

describe("useConfirmDialog (replaces window.confirm)", () => {
  it("is a labelled alert dialog and never uses the native confirm", async () => {
    const native = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    render(<Demo onResult={() => {}} tone="danger" />);
    const box = await ask(user);
    expect(box).toHaveAccessibleName("Delete it?");
    expect(within(box).getByText("This cannot be undone.")).toBeInTheDocument();
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();
  });

  it("resolves true on the confirming button and false on Cancel", async () => {
    const results: boolean[] = [];
    const user = userEvent.setup();
    render(<Demo onResult={(ok) => results.push(ok)} />);
    await user.click(within(await ask(user)).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(results).toEqual([true]));
    await user.click(within(await ask(user)).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results).toEqual([true, false]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("starts with focus on Cancel, so a stray Enter never confirms", async () => {
    const results: boolean[] = [];
    const user = userEvent.setup();
    render(<Demo onResult={(ok) => results.push(ok)} />);
    const box = await ask(user);
    await waitFor(() => expect(within(box).getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("closes with Escape as a cancel, and returns focus to the control that asked", async () => {
    const results: boolean[] = [];
    const user = userEvent.setup();
    render(<Demo onResult={(ok) => results.push(ok)} />);
    await ask(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(results).toEqual([false]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask" })).toHaveFocus());
  });

  it("traps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Demo onResult={() => {}} />);
    const box = await ask(user);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(box.contains(document.activeElement)).toBe(true); // never reaches "Other" behind it
    }
  });
});
