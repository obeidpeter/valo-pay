import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { reconcile } from "../../api-server/src/domain/reconciliation";

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

  it('offers joining held evidence to its payment only where it was held for its connection alone', async () => {
    const user = userEvent.setup();
    const finance = () => ({ actor: 'Sandbox Finance', role: 'Finance', now: api.now });
    const [line, clash] = api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
      const other = state.records.find(record => record.kind === 'customers' && record.id !== due.customerId)!;
      makeRecord(state, 'observations', { name: 'Webhook', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: due.customerId, data: { source: 'webhook', eventId: 'w1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      // The settlement file spells the connection its own way; another payer's evidence under the same reference conflicts.
      const held = makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_487_500, customerId: due.customerId, data: { source: 'settlement', eventId: 's1', provider: 'Sandbox Rail Settlements', grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: 'B-1' } });
      const conflicting = makeRecord(state, 'observations', { name: 'Card', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: other.id, data: { source: 'card', eventId: 'c1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      return [held, conflicting];
    });
    renderApp('/exceptions?view=open&type=suspected_duplicate');
    const codesFor = async (evidence: { id: string }) => {
      const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === evidence.id)!;
      const row = (await screen.findByText(String(exception.data.notes))).closest('tr')!;
      await user.click(within(row).getByRole('button', { name: 'Resolve' }));
      const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
      const labels = within(within(dialog).getByLabelText(/How was this resolved/)).getAllByRole('option').map(option => option.textContent);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve exception' })).toBeNull());
      return labels;
    };
    expect(await codesFor(line)).toEqual(expect.arrayContaining(['Same payment; evidence joined to it', 'Not money; evidence set aside', 'Distinct payments']));
    const conflictCodes = await codesFor(clash);
    expect(conflictCodes).toContain('Not money; evidence set aside');
    expect(conflictCodes).not.toContain('Same payment; evidence joined to it');
  });

  it('shows a stored exception without a severity as having none, never as low', async () => {
    // An earlier edit could clear it; the queue then ranks it below low and the High filter leaves it out.
    const exception = api.mutate((state) => {
      const record = state.records.find((item) => item.kind === 'exceptions' && item.status === 'open' && item.data.severity === 'medium')!;
      delete record.data.severity;
      return record;
    });
    renderApp(`/exceptions?record=${exception.id}`);
    const row = (await screen.findByRole('button', { name: 'Edit' })).closest('tr')!;
    expect(row.textContent).toContain('No severity');
    expect(row.textContent).not.toMatch(/\blow\b/i);
  });

  it('never clears a severity: the edit dialog requires one', async () => {
    const user = userEvent.setup();
    const exception = api.state().records.find((record) => record.kind === 'exceptions' && record.status === 'open' && record.data.severity === 'high' && !record.data.case)!;
    renderApp(`/exceptions?record=${exception.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit exception' });
    const severity = within(dialog).getByLabelText(/^Severity/) as HTMLSelectElement;
    expect(severity.value).toBe('high');
    await user.selectOptions(severity, '');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Severity is required. Choose an option.')).toBeTruthy();
    expect(document.activeElement).toBe(severity);
    expect(api.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(api.state().records.find((record) => record.id === exception.id)!.data.severity).toBe('high');
    // Choosing one saves it.
    await user.selectOptions(severity, 'medium');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.find((record) => record.id === exception.id)!.data.severity).toBe('medium');
  });
});
