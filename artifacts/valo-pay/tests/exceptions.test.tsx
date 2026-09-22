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
    expect(screen.getByRole('tabpanel', { name: 'High severity (1)' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText("Missing consent evidence")).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText("Unallocated payment")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Resolved (0)" }));
    expect(await screen.findByText("Nothing resolved yet")).toBeTruthy();
  });

  it('keeps the issue evidence and a return to the filtered queue in customer review', async () => {
    const user = userEvent.setup();
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.customerId && record.data.type === 'unallocated_payment')!;
    const customer = api.state().records.find(record => record.id === exception.customerId)!;
    renderApp('/exceptions?view=open&owner=Finance&type=unallocated_payment');
    const row = (await screen.findByText(customer.name)).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const context = within(dialog).getByRole('region', { name: 'Exception context' });
    expect(context.textContent).toContain(String(exception.data.notes));
    const destination = within(context).getByRole('link', { name: 'Review customer history' }).getAttribute('href')!;
    const params = new URL(destination, 'https://test.invalid').searchParams;
    const returnParams = new URL(params.get('returnTo')!, 'https://test.invalid');
    expect(returnParams.pathname).toBe('/exceptions');
    expect(returnParams.searchParams.get('owner')).toBe('Finance');
    expect(returnParams.searchParams.get('type')).toBe('unallocated_payment');
    expect(returnParams.searchParams.get('lender')).toBe(api.merchantIds[0]);
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
  });
});
