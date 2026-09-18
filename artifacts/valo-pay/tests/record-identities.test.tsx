import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('recognisable operational records', () => {
  it('shows the customer and references behind a proposed match, while retaining its record IDs', async () => {
    const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
    const customer = api.state().records.find(record => record.id === proposal.customerId)!;
    const payment = api.state().records.find(record => record.id === proposal.data.paymentId)!;
    const dueItem = api.state().records.find(record => record.id === proposal.data.dueItemId)!;
    renderApp('/reconciliation');
    const customerLink = await screen.findByRole('link', { name: customer.name });
    expect(customerLink.getAttribute('href')).toBe(`/customers/${customer.id}`);
    const row = customerLink.closest('tr')!;
    await within(row).findByText(payment.reference);
    expect(within(row).getByText(dueItem.reference)).toBeTruthy();
    expect(row.textContent).toContain(payment.id);
    expect(row.textContent).toContain(dueItem.id);
  });

  it('allocates a payment using a named instalment without requiring the operator to copy a UUID', async () => {
    const user = userEvent.setup();
    const dueItem = api.state().records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Allocate' }));
    const instalment = await screen.findByLabelText(/Instalment/);
    await waitFor(() => expect(within(instalment).getByRole('option', { name: new RegExp(dueItem.reference) })).toBeTruthy());
    await user.selectOptions(instalment, dueItem.id);
    const amount = screen.getByLabelText(/Amount \(Kobo\)/);
    await user.clear(amount);
    await user.type(amount, '100000');
    await user.type(screen.getByLabelText(/Reason/), 'Matched the synthetic payment evidence to this instalment.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some(call => {
      const body = call.body as { action?: string; data?: { dueItemId?: string; amountKobo?: number } };
      return body?.action === 'manual_allocate' && body.data?.dueItemId === dueItem.id && body.data.amountKobo === 100000;
    })).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
