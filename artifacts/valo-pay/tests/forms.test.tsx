import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("forms", () => {
  it("names each missing value at its field, focuses the first, and asks the server for nothing", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add Customer" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/fields need attention before this can be saved/);
    expect(screen.getByText("Enter the Full Name.")).toBeTruthy();
    expect(screen.getByText("Enter the LMS Reference.")).toBeTruthy();
    const name = screen.getByLabelText(/Full Name/);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("record-name-error");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    // Correcting a field drops its message at once.
    await user.type(name, "Bola Adeyemi");
    expect(screen.queryByText("Enter the Full Name.")).toBeNull();
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("puts what the server refuses under the field it names, and the rest in the alert", async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/customers$/, { status: 400, error: "Validation failed.", details: [{ field: "reference", message: "This reference is already used by another customer." }] }, "POST");
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add Customer" }));
    await user.type(await screen.findByLabelText(/Full Name/), "Bola Adeyemi");
    const reference = screen.getByLabelText(/LMS Reference/);
    await user.type(reference, "DEMO-C1001");
    const status = screen.getByLabelText(/Status/) as HTMLSelectElement;
    if (!status.value) await user.selectOptions(status, status.options[1]!.value);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reference.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("This reference is already used by another customer.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/One field needs attention/);
    expect(document.activeElement).toBe(reference);
    // A refusal that names no field is the alert itself.
    api.failNext(/^\/v1\/records\/customers$/, { status: 403, error: "Only an Admin can add customers." }, "POST");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Only an Admin can add customers."));
    expect(reference.getAttribute("aria-invalid")).toBeNull();
  });

  it("does the same for the mandate form", async () => {
    const user = userEvent.setup();
    renderApp("/mandates");
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Create synthetic mandate" }));
    await user.click(await screen.findByRole("button", { name: "Create mandate" }));
    expect(screen.getByText("Enter the Mandate name.")).toBeTruthy();
    expect(screen.getByText("Choose the Customer.")).toBeTruthy();
    const name = screen.getByLabelText(/Mandate name/);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-describedby")).toBe("mandate-name-error");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });
});
