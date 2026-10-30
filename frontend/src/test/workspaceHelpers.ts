import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** The table row a key is listed in. */
export const keyRow = (label: string) => within(screen.getByRole("table")).getByText(label).closest("tr") as HTMLElement;

/** Open a key's "⋯" menu and choose an action, the way a user does. */
export async function chooseKeyAction(user: UserEvent, label: string, action: string | RegExp) {
  await user.click(within(keyRow(label)).getByRole("button", { name: `More actions for ${label}` }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}
