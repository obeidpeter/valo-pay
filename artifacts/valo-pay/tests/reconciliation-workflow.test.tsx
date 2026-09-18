import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { formatKobo } from '@/lib/formatters';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('reconciliation decisions', () => {
  it.each([
    ['Confirm', 'Confirm payment allocation', 'Confirm allocation', 'confirm_allocation', 'confirmed', 'allocated'],
    ['Reject', 'Reject proposed match', 'Reject allocation', 'reject_allocation', 'superseded', 'unallocated'],
  ])('%s sends the payment ID and completes against the real domain action', async (rowAction, title, submit, action, allocationStatus, paymentStatus) => {
    const user = userEvent.setup();
    const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
    const payment = api.state().records.find(record => record.id === proposal.data.paymentId)!;
    const due = api.state().records.find(record => record.id === proposal.data.dueItemId)!;
    renderApp('/reconciliation?view=review');
    await user.click(await screen.findByRole('button', { name: rowAction }));
    const dialog = await screen.findByRole('dialog', { name: title });
    const evidence = within(dialog).getByRole('region', { name: 'Match evidence' });
    await within(evidence).findByText(payment.reference);
    expect(within(evidence).getByText(due.reference)).toBeTruthy();
    expect(evidence.textContent).toContain(String(proposal.data.explanation));
    expect(evidence.textContent).toContain('Available to allocate');
    expect(evidence.textContent).toContain(formatKobo(proposal.amountKobo));
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Reviewed the synthetic payment and instalment evidence.');
    await user.click(within(dialog).getByRole('button', { name: submit }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = api.calls.find(call => (call.body as { action?: string })?.action === action);
    expect(call?.body).toMatchObject({ action, recordId: payment.id });
    expect(call?.status).toBe(200);
    expect(api.state().records.find(record => record.id === proposal.id)?.status).toBe(allocationStatus);
    expect(api.state().records.find(record => record.id === payment.id)?.status).toBe(paymentStatus);
    await screen.findByText('No proposed matches to review');
  });

  it('shows a duplicates-only queue with a filtered route to the review work', async () => {
    api.mutate(state => {
      const payment = state.records.find(record => record.kind === 'payments' && record.status === 'unallocated')!;
      payment.status = 'possible_duplicate';
      payment.data.explanation = 'The same provider reference appears on another payment.';
    });
    renderApp('/reconciliation?view=duplicates');
    const section = await screen.findByRole('region', { name: 'Possible duplicate payments' });
    await within(section).findByText('SBX-UNIDENTIFIED-001');
    expect(within(section).getByText('The same provider reference appears on another payment.')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Review exceptions' }).getAttribute('href')).toBe('/exceptions?type=suspected_duplicate');
    expect(screen.queryByRole('heading', { name: 'Proposed matches' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Unallocated payments' })).toBeNull();
  });
});

describe('reconciliation result visibility', () => {
  it('moves resolved evidence into its current payment queue and refreshes all affected records', async () => {
    const user = userEvent.setup();
    const reference = 'NEW-UNMATCHED-EVIDENCE';
    api.mutate(state => {
      const observation = state.records.find(record => record.kind === 'observations')!;
      state.records.push({ ...observation, id: randomUUID(), reference, customerId: '', name: 'New sample evidence', status: 'unresolved', amountKobo: 100001, data: { source: 'webhook', provider: 'Sandbox Rail', synthetic: true } });
    });
    renderApp('/reconciliation');
    await screen.findByText(reference);
    const getCount = (path: string) => api.calls.filter(call => call.method === 'GET' && call.path === path).length;
    const paths = ['/v1/records/payments', '/v1/records/observations', '/v1/records/allocations', '/v1/records/settlement-batches', '/v1/reports'];
    await waitFor(() => paths.forEach(path => expect(getCount(path)).toBeGreaterThan(0)));
    const before = paths.map(getCount);
    await user.click(screen.getByRole('button', { name: 'Run reconciliation' }));
    const result = await screen.findByRole('status', { name: 'Reconciliation result' });
    expect(result.textContent).toContain('Reconciliation complete');
    await waitFor(() => paths.forEach((path, index) => expect(getCount(path)).toBeGreaterThan(before[index]!)));
    const evidenceTable = screen.getByRole('columnheader', { name: 'Source' }).closest('table')!;
    await waitFor(() => expect(within(evidenceTable).queryByText(reference)).toBeNull());
    const payments = screen.getByRole('heading', { name: 'Unallocated payments' }).parentElement!.parentElement!;
    await within(payments).findByText(reference);
    expect(api.state().records.find(record => record.kind === 'payments' && record.reference === reference)?.status).toBe('unallocated');
    const unallocated = api.state().records.filter(record => record.kind === 'payments' && record.status === 'unallocated').length;
    expect(within(result).getByText('Unallocated payments').parentElement?.textContent).toContain(String(unallocated));
  });

  it('keeps an explicit error until a successful retry replaces it with the result', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, { status: 503, error: 'The reconciliation service is temporarily unavailable.' }, 'POST');
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Run reconciliation' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Reconciliation could not be completed');
    expect(alert.textContent).toContain('Run reconciliation again to retry.');
    expect(screen.queryByRole('status', { name: 'Reconciliation result' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Run reconciliation' }));
    await screen.findByRole('status', { name: 'Reconciliation result' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('allocation amounts', () => {
  it('shows naira balances, blocks excess precision and over-allocation, and submits exact kobo', async () => {
    const user = userEvent.setup();
    const payment = api.state().records.find(record => record.kind === 'payments' && record.status === 'unallocated')!;
    const due = api.state().records.find(record => record.kind === 'due-items' && Number(record.data.outstandingKobo) > 0 && Number(record.data.outstandingKobo) < payment.amountKobo)!;
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    const amount = within(dialog).getByLabelText(/Amount to allocate \(₦\)/) as HTMLInputElement;
    expect(amount.value).toBe('32000.00');
    expect(amount.inputMode).toBe('decimal');
    await user.selectOptions(within(dialog).getByLabelText(/^Instalment/), due.id);
    const preview = within(dialog).getByRole('region', { name: 'Allocation preview' });
    expect(preview.textContent).toContain(formatKobo(Number(due.data.outstandingKobo)));
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Review the sample allocation amount.');
    await user.clear(amount);
    await user.type(amount, '1.001');
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    expect(within(dialog).getByText(/no more than 2 decimal places/)).toBeTruthy();
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    await user.clear(amount);
    await user.type(amount, '32000');
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    expect(within(dialog).getByText(/This is the instalment still due/)).toBeTruthy();
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    await user.clear(amount);
    await user.type(amount, '1,000.29');
    expect(preview.textContent).toContain('After allocation:');
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = api.calls.find(call => (call.body as { action?: string })?.action === 'manual_allocate');
    expect(call?.body).toMatchObject({ recordId: payment.id, data: { amountKobo: 100029, dueItemId: due.id } });
    expect(call?.status).toBe(200);
  });
});
