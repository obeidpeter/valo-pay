import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("layout", () => {
  it("loads the first lender and switches to the second", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations Overview" });
    const [first, second] = api.merchantIds as [string, string];
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === first)).toBe(true);
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(false);
    expect(screen.getByText("MODE: sandbox")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Active lender"), second);
    await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(true));
    expect(document.title).toBe("Overview · Valo Pay");
  });

  it("navigates between pages from the sidebar", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations Overview" });
    await user.click(screen.getByRole("link", { name: /Audit Log/ }));
    expect(await screen.findByRole("button", { name: /Verify Chain Integrity/ })).toBeTruthy();
    expect(document.title).toBe("Audit Log · Valo Pay");
    // The brand in the sidebar leads back to the landing page, the same lockup as on it.
    expect(screen.getByRole("link", { name: /Go to the start/ }).getAttribute("href")).toBe("/");
  });
});
