import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("exceptions", () => {
  it("filters all open, high severity and resolved exceptions with live counts", async () => {
    const user = userEvent.setup();
    renderApp("/exceptions");
    const open = await screen.findByRole("tab", { name: "All open (4)" });
    expect(open.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole('table')).getByText("Missing consent evidence")).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByText("Unallocated payment")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "High severity (1)" }));
    expect(within(screen.getByRole('table')).getByText("Missing consent evidence")).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText("Unallocated payment")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Resolved (0)" }));
    expect(await screen.findByText("Nothing resolved yet")).toBeTruthy();
  });
});
