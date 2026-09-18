import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

// jsdom applies no stylesheet, so the phone bar and the sidebar are both in the
// document here; the browser shows one or the other. What these tests pin is
// that the two offer the same pages and the same lender, and how the drawer
// opens, navigates, closes and hands focus on.
describe("responsive layout", () => {
  it("offers the same pages and lender in the phone bar's drawer as in the sidebar, with the current page marked", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations Overview" });
    // The lender is chosen in the same place on a phone and on a desktop: once each, the same name.
    const lenders = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    expect(lenders).toHaveLength(2);
    expect(lenders.map((select) => select.value)).toEqual([api.merchantIds[0], api.merchantIds[0]]);
    const [sidebarPages] = screen.getAllByRole("navigation", { name: "Pages" });
    const sidebarLabels = within(sidebarPages!).getAllByRole("link").map((link) => link.textContent);
    expect(sidebarLabels).toHaveLength(11);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    const drawerLabels = within(drawer).getAllByRole("link").map((link) => link.textContent);
    expect(drawerLabels).toEqual(sidebarLabels);
    expect(within(drawer).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(within(drawer).getByRole("link", { name: "Audit Log" }).getAttribute("aria-current")).toBeNull();
  });

  it("closes the drawer after a page is chosen in it and moves focus to the page content, as the sidebar does", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations Overview" });
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Audit Log" }));
    await screen.findByRole("heading", { name: "Audit Log" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
    expect(document.title).toBe("Audit Log · Valo Pay");
  });

  it("closes the drawer on Escape and returns focus to the Menu button", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    const menu = screen.getByRole("button", { name: "Menu" });
    await user.click(menu);
    await screen.findByRole("dialog", { name: "Menu" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(menu));
    // Nothing was navigated: the page and its title are as they were.
    expect(document.title).toBe("Customers · Valo Pay");
    expect(screen.getByText("Ada Okonkwo")).toBeTruthy();
  });

  it("switches the lender from the phone bar and the drawer follows the change of page", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations Overview" });
    const [first, second] = api.merchantIds as [string, string];
    const [phoneLender] = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    await user.selectOptions(phoneLender!, second);
    await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(true));
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === first)).toBe(true);
    // Both selectors show the same lender: one choice, shown in two places.
    const lenders = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    expect(lenders.map((select) => select.value)).toEqual([second, second]);
  });
});
