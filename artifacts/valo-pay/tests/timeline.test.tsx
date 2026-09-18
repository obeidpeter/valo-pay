import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("customer timeline", () => {
  it("shows the customer, the derived position and generates a dispute pack", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    window.open = opened as typeof window.open;
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    renderApp(`/customers/${ada.id}`);
    expect(await screen.findByRole("heading", { name: "Ada Okonkwo" })).toBeTruthy();
    expect(screen.getByText("DEMO-C1001")).toBeTruthy();
    expect(screen.getByText("Current Position")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Dispute pack (PDF)" }));
    expect(await screen.findByText("Dispute pack generated")).toBeTruthy();
    const request = api.calls.find((call) => call.method === "POST" && call.path === "/v1/exports");
    expect(request?.body).toEqual({ kind: "dispute-pack", format: "pdf", customerId: ada.id });
    const record = api.state().records.find((item) => item.kind === "exports")!;
    expect(record.customerId).toBe(ada.id);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(`/api/v1/exports/${record.id}/download?merchantId=${api.merchantIds[0]}`, "_blank"));
    expect(screen.getByText(new RegExp(`SHA-256 ${String(record.data.checksum).slice(0, 16)}`))).toBeTruthy();
  });

  it("says when the lender has no customer with the reference, inside the console", async () => {
    renderApp("/customers/not-a-customer");
    expect(await screen.findByRole("heading", { level: 1, name: "No customer with this reference" })).toBeTruthy();
    expect(screen.getByText("not-a-customer")).toBeTruthy();
    expect(api.calls.find((call) => call.path.endsWith("/timeline"))?.status).toBe(404);
    // The sidebar stays as the way out, and each action names where it goes.
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to customers" }).getAttribute("href")).toBe("/customers");
    expect(screen.getByRole("link", { name: "Go to the overview" }).getAttribute("href")).toBe("/overview");
    await waitFor(() => expect(document.title).toBe("Customer not found · Valo Pay"));
  });
});
