import { randomUUID } from 'node:crypto';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { formatKobo } from '@/lib/formatters';
import { permissionReason } from '@/lib/permissions';
import { executeAction } from '../../api-server/src/domain/actions';
import { makeRecord } from '../../api-server/src/domain/records';
import { reconcile } from '../../api-server/src/domain/reconciliation';
import { canTakeAllocation } from '@workspace/valopay-schema';

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
    expect((await within(evidence).findAllByText(payment.reference)).length).toBeGreaterThan(0);
    expect(within(evidence).getByText(due.reference)).toBeTruthy();
    expect(evidence.textContent).toContain(String(proposal.data.explanation));
    expect(evidence.textContent).toContain('Available to allocate');
    expect(evidence.textContent).toContain(formatKobo(proposal.amountKobo));
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Reviewed the synthetic payment and instalment evidence.');
    await user.click(within(dialog).getByRole('button', { name: submit }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = api.calls.find(call => (call.body as { action?: string })?.action === action);
    expect(call?.body).toMatchObject({ action, recordId: payment.id, data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } });
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

  it('keeps the decision open when the displayed proposal has changed on the server', async () => {
    const user = userEvent.setup();
    const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
    renderApp('/reconciliation?view=review');
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm payment allocation' });
    const reason = within(dialog).getByLabelText(/^Reason/);
    await user.type(reason, 'Reviewed the payment and original proposal.');
    api.mutate(state => { state.records.find(record => record.id === proposal.id)!.updatedAt = '2027-12-01T12:00:00.000Z'; });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm allocation' }));
    expect(await within(dialog).findByText(/This proposed match has changed since you opened it/)).toBeTruthy();
    expect((reason as HTMLTextAreaElement).value).toBe('Reviewed the payment and original proposal.');
    expect(api.state().records.find(record => record.id === proposal.id)?.status).toBe('proposed');
    expect(api.calls.find(call => (call.body as any)?.action === 'confirm_allocation')?.status).toBe(409);
  });

  it('shows the financial effect and source records before correcting an automatic match', async () => {
    const user = userEvent.setup();
    api.setNow('2027-02-15T12:00:00.000Z');
    api.mutate(state => { for (const record of state.records.filter(row => row.kind === 'allocations' && row.status === 'confirmed')) record.data.confirmedAt = '2027-01-20T12:00:00.000Z'; });
    renderApp('/reconciliation');
    await user.click((await screen.findAllByRole('button', { name: 'Mark incorrect' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Review payment allocation' });
    const evidence = within(dialog).getByRole('region', { name: 'Match evidence' });
    expect(evidence.textContent).toContain('This corrects the recorded allocation');
    expect(evidence.textContent).toContain('does not refund or move money');
    expect(evidence.textContent).toContain('Receipt status:');
    expect(evidence.textContent).toContain('Settlement:');
    expect(evidence.textContent).toContain('Provider fees are reviewed separately');
    expect(evidence.textContent).toContain('After correction:');
    await user.click(within(dialog).getByRole('checkbox'));
    expect(evidence.textContent).toContain('keeps the allocation applied');
    expect(evidence.textContent).not.toContain('After correction:');
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
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
    const paths = ['/v1/reconciliation/payments', '/v1/reconciliation/observations', '/v1/reconciliation/proposals', '/v1/reconciliation/batches', '/v1/reconciliation/audit'];
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

describe('external refunds', () => {
  it('explains, instead of offering, a refund the service would refuse', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const open = state.records.find(record => record.kind === 'payments' && record.status === 'unallocated')!;
      // An overpayment whose ₦5,000 excess was refunded, then whose allocation was superseded: it holds money again.
      state.records.push({ ...open, id: randomUUID(), reference: 'SBX-REFUNDED-EXCESS', amountKobo: 3_000_000, data: { ...open.data, allocatedKobo: 0, refundStatus: 'refunded', refundedKobo: 500_000, refundReference: 'RF-EXCESS' } });
      state.records.push({ ...open, id: randomUUID(), reference: 'SBX-REVERSED', data: { ...open.data, reversalStatus: 'reversed' } });
    });
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    await within(payments).findByText('SBX-REFUNDED-EXCESS');
    const refundFor = (reference: string) => within(payments).getByRole('button', { name: `Record external refund for ${reference}` });
    const reasonFor = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-describedby') || '')?.textContent;
    const refunded = refundFor('SBX-REFUNDED-EXCESS');
    expect(refunded.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(refunded)).toBe('A refund is already recorded for this payment.');
    // Reversed money went back, so it waits for no one and is not in Finance's queue, even with the status an earlier build left.
    expect(within(payments).queryByText('SBX-REVERSED')).toBeNull();
    const reversed = api.state().records.find(record => record.reference === 'SBX-REVERSED')!;
    expect(permissionReason({ role: 'Finance', actor: 'Sandbox Finance' }, { action: 'record_refund', record: reversed })).toBe('The provider reversed this payment, so its money already went back.');
    await user.click(refunded);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    // What stayed with the lender can still be allocated, and a payment with no refund recorded can still record one.
    const refundedRow = within(payments).getByText('SBX-REFUNDED-EXCESS').closest('tr')!;
    expect(within(refundedRow).getByRole('button', { name: 'Allocate' }).getAttribute('aria-disabled')).toBeNull();
    const open = refundFor('SBX-UNIDENTIFIED-001');
    expect(open.getAttribute('aria-disabled')).toBeNull();
    await user.click(open);
    expect(await screen.findByRole('dialog', { name: 'Record external refund' })).toBeTruthy();
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
    expect(within(dialog).getAllByText(/no more than 2 decimal places/).length).toBeGreaterThan(0);
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    await user.clear(amount);
    await user.type(amount, '32000');
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    expect(within(dialog).getAllByText(/This is the instalment still due/).length).toBeGreaterThan(0);
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

describe('allocation picker search', () => {
  it('asks for instalment choices once after a pause in typing, and Back leaves the page instead of stepping through letters', async () => {
    const user = userEvent.setup();
    const dueItem = api.state().records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    await user.click(screen.getAllByRole('link', { name: 'Reconciliation' })[0]!);
    await user.click((await screen.findAllByRole('button', { name: 'Allocate' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    const choiceRequests = () => api.calls.filter(call => call.path === '/v1/records/due-items').map(call => call.query.search);
    await waitFor(() => expect(choiceRequests()).toEqual(['']));
    const entries = window.history.length;
    await user.type(within(dialog).getByLabelText('Find an instalment'), dueItem.reference);
    await waitFor(() => expect(choiceRequests()).toContain(dueItem.reference));
    expect(choiceRequests()).toEqual(['', dueItem.reference]);
    await waitFor(() => expect(within(dialog).queryByText('Loading instalment choices…')).toBeNull());
    const choices = within(within(dialog).getByLabelText(/^Instalment/)).getAllByRole('option').filter(option => (option as HTMLOptionElement).value);
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every(option => option.textContent!.includes(dueItem.reference))).toBe(true);
    expect(window.history.length).toBe(entries);
    await act(async () => { window.history.back(); });
    await screen.findByRole('heading', { name: 'Operations overview' });
    expect(window.location.pathname).toBe('/overview');
  });
});

describe('allocation picker counts', () => {
  it('counts only the instalments it offers, and says so plainly when none can take the payment', async () => {
    const user = userEvent.setup();
    const open = api.state().records.filter(record => record.kind === 'due-items' && Number(record.data.outstandingKobo) > 0 && !['cancelled', 'closed', 'in_dispute'].includes(record.status));
    const paid = api.state().records.find(record => record.kind === 'due-items' && record.status === 'paid')!;
    expect(open.length).toBeLessThan(api.state().records.filter(record => record.kind === 'due-items').length);
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    await waitFor(() => expect(within(dialog).queryByText('Loading instalment choices…')).toBeNull());
    const offered = () => within(within(dialog).getByLabelText(/^Instalment/)).getAllByRole('option').filter(option => (option as HTMLOptionElement).value);
    expect(offered().map(option => (option as HTMLOptionElement).value).sort()).toEqual(open.map(record => record.id).sort());
    expect(within(dialog).getByText(`1–${open.length} of ${open.length} instalment choices`)).toBeTruthy();
    // The server filters the page, so the count it gives is the count of choices.
    expect(api.calls.filter(call => call.path === '/v1/records/due-items').every(call => call.query.allocatable === 'true')).toBe(true);
    await user.type(within(dialog).getByLabelText('Find an instalment'), paid.reference);
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/due-items' && call.query.search === paid.reference)).toBe(true));
    await waitFor(() => expect(within(dialog).queryByText('Loading instalment choices…')).toBeNull());
    expect(offered()).toHaveLength(0);
    expect(within(dialog).getByText('No instalment that can take a payment matches this search.')).toBeTruthy();
    expect(within(dialog).getByText('Instalments that are paid, cancelled, closed or in dispute cannot take a payment and are not listed.')).toBeTruthy();
    expect(within(dialog).queryByRole('navigation', { name: 'instalment choices pagination' })).toBeNull();
  });
});

describe('payer confirmation', () => {
  const finance = () => ({ actor: 'Sandbox Finance', role: 'Finance', now: api.now });

  it('records the payer when Finance allocates a payment whose evidence named none', async () => {
    const user = userEvent.setup();
    const payment = api.state().records.find(record => record.kind === 'payments' && record.reference === 'SBX-UNIDENTIFIED-001')!;
    const due = api.state().records.find(record => record.kind === 'due-items' && Number(record.data.outstandingKobo) > 0 && Number(record.data.outstandingKobo) < payment.amountKobo)!;
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    const preview = within(dialog).getByRole('region', { name: 'Allocation preview' });
    expect(preview.textContent).toContain('Recorded payer: Not identified');
    expect(preview.textContent).toContain('Allocating records that customer as the payer, with your reason, in the same action.');
    await waitFor(() => expect(within(within(dialog).getByLabelText(/^Instalment/)).getAllByRole('option').some(option => (option as HTMLOptionElement).value === due.id)).toBe(true));
    await user.selectOptions(within(dialog).getByLabelText(/^Instalment/), due.id);
    expect(preview.textContent).toContain('Payer to be recorded:');
    const amount = within(dialog).getByLabelText(/Amount to allocate \(₦\)/);
    await user.clear(amount);
    await user.type(amount, (Number(due.data.outstandingKobo) / 100).toFixed(2));
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Payer confirmed from the transfer narration.');
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find(call => (call.body as { action?: string })?.action === 'manual_allocate')?.status).toBe(200);
    const saved = api.state().records.find(record => record.id === payment.id)!;
    expect(saved.customerId).toBe(due.customerId);
    expect(saved.data.payerIdentification).toMatchObject({ customerId: due.customerId, identifiedBy: 'Sandbox Admin', reason: 'Payer confirmed from the transfer narration.', dueItemId: due.id });
    expect((await screen.findAllByText('Payer recorded')).length).toBeGreaterThan(0);
  });

  it('confirms a debit match whose settlement line named no payer, recording the payer', async () => {
    const user = userEvent.setup();
    const due = api.state().records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1006')!;
    const customer = api.state().records.find(record => record.id === due.customerId)!;
    api.mutate(state => {
      makeRecord(state, 'attempts', { name: 'External debit', status: 'sent', customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, number: 1, source: 'external', simulated: true, providerReference: 'PSK-NO-PAYER', occurredAt: api.now } });
      makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-NO-PAYER', amountKobo: due.amountKobo - 30_000, customerId: '', data: { source: 'settlement', grossAmountKobo: due.amountKobo, feeKobo: 30_000, batchReference: 'B-NO-PAYER', eventId: 'no-payer-line', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
    });
    const payment = api.state().records.find(record => record.kind === 'payments' && record.reference === 'PSK-NO-PAYER')!;
    expect([payment.customerId, payment.status]).toEqual(['', 'proposed']);
    renderApp('/reconciliation?view=review');
    const row = (await screen.findByText('PSK-NO-PAYER')).closest('tr')!;
    expect(row.textContent).toContain('Payer to confirm');
    expect(row.textContent).toContain(customer.name);
    await user.click(within(row).getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm payment allocation' });
    const evidence = within(dialog).getByRole('region', { name: 'Match evidence' });
    expect(evidence.textContent).toContain(`The payment evidence names no payer. Confirming records ${customer.name} as the payer, with your reason, in the same action.`);
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Our debit reference names this instalment.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm allocation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find(call => (call.body as { action?: string })?.action === 'confirm_allocation')?.status).toBe(200);
    const saved = api.state().records.find(record => record.id === payment.id)!;
    expect([saved.customerId, saved.status, saved.data.payerIdentification?.reason]).toEqual([due.customerId, 'allocated', 'Our debit reference names this instalment.']);
    expect(api.state().records.find(record => record.id === due.id)?.status).toBe('paid');
  });

  it("offers only a known payer's instalments, and shows what a partly allocated payment still holds", async () => {
    const user = userEvent.setup();
    const due = api.state().records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1006')!;
    api.mutate(state => {
      makeRecord(state, 'observations', { name: 'Transfer', status: 'unresolved', reference: 'TRF-PART-PAID', amountKobo: 5_000_000, customerId: due.customerId, data: { source: 'transfer', eventId: 'part-paid', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      const payment = state.records.find(record => record.kind === 'payments' && record.reference === 'TRF-PART-PAID')!;
      executeAction(state, finance(), { action: 'manual_allocate', recordId: payment.id, reason: 'Part of the transfer pays this instalment.', data: { dueItemId: due.id, amountKobo: 1_000_000 } });
    });
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('TRF-PART-PAID')).closest('tr')!;
    expect(row.textContent).toContain(`${formatKobo(4_000_000)} left to allocate`);
    await user.click(within(row).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    expect(within(dialog).getByRole('region', { name: 'Allocation preview' }).textContent).toContain("Only this payer's instalments are offered.");
    const payment = api.state().records.find(record => record.kind === 'payments' && record.reference === 'TRF-PART-PAID')!;
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/due-items' && call.query.paymentId === payment.id && call.query.allocatable === 'true')).toBe(true));
    await waitFor(() => expect(within(dialog).queryByText('Loading instalment choices…')).toBeNull());
    const options = within(within(dialog).getByLabelText(/^Instalment/)).getAllByRole('option').filter(option => (option as HTMLOptionElement).value);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(option => api.state().records.find(record => record.id === (option as HTMLOptionElement).value)?.customerId === due.customerId)).toBe(true);
  });

  it("offers a payment whose evidence names an instalment but no payer only that instalment's customer's instalments, each one it can take", async () => {
    const user = userEvent.setup();
    const due = api.state().records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
    api.mutate(state => {
      makeRecord(state, 'observations', { name: 'Transfer', status: 'unresolved', reference: 'TRF-NAMED-1', amountKobo: 1_000_000, customerId: '', data: { source: 'transfer', eventId: 'named-1', provider: 'Sandbox Rail', dueItemId: due.id } });
      reconcile(state, finance());
    });
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('TRF-NAMED-1')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    expect(within(dialog).getByRole('region', { name: 'Allocation preview' }).textContent).toContain("Its evidence names an instalment, so only the instalments of that instalment's customer are offered.");
    await waitFor(() => expect(within(dialog).queryByText('Loading instalment choices…')).toBeNull());
    const options = within(within(dialog).getByLabelText(/^Instalment/)).getAllByRole('option').filter(option => (option as HTMLOptionElement).value);
    const open = api.state().records.filter(record => record.kind === 'due-items' && record.customerId === due.customerId && canTakeAllocation(record as any));
    expect(options.map(option => (option as HTMLOptionElement).value).sort()).toEqual(open.map(record => record.id).sort());
  });
});

describe('settlement batch edits', () => {
  it('sends the fields the dialog shows, never the lines the batch recorded', async () => {
    // Every edit sent the batch's stored data back whole: with about 5,000 lines or more its line lists pass the API's
    // 10,000-value body cap, so the batch could no longer be edited (413). An edit merges data, so it sends only its fields.
    const user = userEvent.setup();
    const lines = Array.from({ length: 6000 }, (_, index) => `line-${index}`);
    const batch = api.mutate(state => makeRecord(state, 'settlement-batches', {
      name: 'Large settlement batch', status: 'reconciled', reference: 'LARGE-BATCH-1',
      data: { provider: state.merchant.provider, batchReference: 'LARGE-BATCH-1', grossKobo: 1_000_000, feeKobo: 10_000, netKobo: 990_000, lineObservationIds: lines, linePaymentIds: lines.map(id => `payment-${id}`) },
    }));
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Edit settlement batch LARGE-BATCH-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit settlement batch' });
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Large settlement batch, checked');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit settlement batch' })).toBeNull());
    const sent = api.calls.find(call => call.method === 'PATCH' && call.path === `/v1/records/settlement-batches/${batch.id}`)!;
    expect(sent.status).toBe(200);
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('lineObservationIds');
    expect(data).not.toHaveProperty('linePaymentIds');
    expect(Object.keys(data).sort()).toEqual(['feeKobo', 'grossKobo', 'netKobo', 'provider']);
    // What an edit leaves out, the service keeps.
    const saved = api.state().records.find(record => record.id === batch.id)!;
    expect(saved.name).toBe('Large settlement batch, checked');
    expect(saved.data.lineObservationIds).toHaveLength(6000);
    expect(saved.data.linePaymentIds).toHaveLength(6000);
    expect(saved.data.batchReference).toBe('LARGE-BATCH-1');
  });
});
