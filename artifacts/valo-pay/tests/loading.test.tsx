import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("loading and waiting", () => {
  it("names what a page is waiting for, then shows it", async () => {
    const release = api.hold(/^\/v1\/overview$/);
    renderApp("/overview");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Loading the overview…"));
    expect(screen.queryByRole("heading", { name: "Operations Overview" })).toBeNull();
    release();
    expect(await screen.findByRole("heading", { name: "Operations Overview" })).toBeTruthy();
    expect(screen.queryByText(/^Loading /)).toBeNull();
  });

  it("names what a table is waiting for, in its own row", async () => {
    const release = api.hold(/^\/v1\/records\/due-items$/);
    renderApp("/collections");
    const row = await screen.findByText("Loading due items…");
    expect(row.closest("tr")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByText("Loading due items…")).toBeNull());
  });

  it("says what a button is doing while its action runs, and cannot be pressed again", async () => {
    const user = userEvent.setup();
    const release = api.hold(/^\/v1\/actions$/);
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Verify Chain Integrity/ }));
    const busy = await screen.findByRole("button", { name: "Verifying…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    release();
    expect(await screen.findByText("Chain intact")).toBeTruthy();
    const restored = screen.getByRole("button", { name: /Verify Chain Integrity/ });
    expect(restored.hasAttribute("disabled")).toBe(false);
    expect(restored.getAttribute("aria-busy")).toBeNull();
  });

  it("marks only the export that was asked for as being generated", async () => {
    const user = userEvent.setup();
    window.open = vi.fn() as typeof window.open;
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    const release = api.hold(/^\/v1\/exports$/);
    renderApp(`/customers/${ada.id}`);
    await user.click(await screen.findByRole("button", { name: "CSV" }));
    expect(await screen.findByRole("button", { name: "Generating…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dispute pack (PDF)" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "JSON" }).hasAttribute("disabled")).toBe(true);
    release();
    expect(await screen.findByText("Dispute pack generated")).toBeTruthy();
    expect(screen.getByRole("button", { name: "CSV" }).hasAttribute("disabled")).toBe(false);
  });
});
