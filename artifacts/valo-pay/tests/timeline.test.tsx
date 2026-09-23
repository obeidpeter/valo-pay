import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { queryClient, queryDefaults } from "@/App";

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
    expect(screen.getByText("Customer position")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Export dispute pack (PDF)" }));
    expect(await screen.findByText("Dispute pack ready")).toBeTruthy();
    const request = api.calls.find((call) => call.method === "POST" && call.path === "/v1/exports");
    expect(request?.body).toEqual({ kind: "dispute-pack", format: "pdf", customerId: ada.id });
    const record = api.state().records.find((item) => item.kind === "exports")!;
    expect(record.customerId).toBe(ada.id);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(`/api/v1/exports/${record.id}/download?merchantId=${api.merchantIds[0]}`, "_blank"));
    // Radix also announces a new notice through a hidden copy for a moment, so the text may be present twice.
    expect(screen.getAllByText(new RegExp(`SHA-256 checksum: ${String(record.data.checksum).slice(0, 16)}`)).length).toBeGreaterThanOrEqual(1);
  });

  it("says when the lender has no customer with the reference, inside the console", async () => {
    renderApp("/customers/not-a-customer");
    expect(await screen.findByRole("heading", { level: 1, name: "Customer not found" })).toBeTruthy();
    expect(screen.getByText("not-a-customer")).toBeTruthy();
    expect(api.calls.find((call) => call.path.endsWith("/history"))?.status).toBe(404);
    // The sidebar stays as the way out, and each action names where it goes.
    expect(screen.getByRole("link", { name: /Audit log/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to customers" }).getAttribute("href")).toBe("/customers");
    expect(screen.getByRole("link", { name: "Go to overview" }).getAttribute("href")).toBe("/overview");
    await waitFor(() => expect(document.title).toBe("Customer not found · Valo Pay"));
  });

  it("says when the lender has no case with the ID, at once and after one request", async () => {
    // The app's own retry rule, without its delay: a 404 is shown at once, never repeated.
    const testDefaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ queries: { ...queryDefaults.queries, retryDelay: 0 } });
    try {
      renderApp("/cases/no-such-case");
      expect(await screen.findByRole("heading", { level: 1, name: "Case not found" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Coordinate a case" })).toBeNull();
      expect(screen.getByText("no-such-case")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("link", { name: "Back to exceptions" }).getAttribute("href")).toBe("/exceptions");
      expect(screen.getByRole("link", { name: "Go to overview" }).getAttribute("href")).toBe("/overview");
      await waitFor(() => expect(document.title).toBe("Case not found · Valo Pay"));
      expect(api.calls.filter((call) => call.path === "/v1/pilot/cases/no-such-case").map((call) => call.status)).toEqual([404]);
    } finally {
      queryClient.setDefaultOptions(testDefaults);
    }
  });

  it("keeps a temporary case loading failure retryable", async () => {
    api.failNext(/^\/v1\/pilot\/cases\/no-such-case$/, { status: 503, error: "The service is busy. Try again in a moment." });
    renderApp("/cases/no-such-case");
    expect(await screen.findByText(/^The service is busy\. Try again in a moment\./)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Coordinate a case" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
