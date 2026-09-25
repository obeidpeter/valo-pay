import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { raiseException, reconcile } from "../../api-server/src/domain/reconciliation";

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

  // Third review of the audit fixes, finding 3: the dialog said resolving only records an outcome, whatever the
  // reconciliation then did with the evidence, and the page never showed the service's answer or moved focus to it.
  it('says what each resolution of held evidence does, then shows the service\'s answer and moves focus to it', async () => {
    const user = userEvent.setup();
    const finance = () => ({ actor: 'Sandbox Finance', role: 'Finance', now: api.now });
    const line = api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
      makeRecord(state, 'observations', { name: 'Webhook', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: due.customerId, data: { source: 'webhook', eventId: 'w1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      const held = makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_487_500, customerId: due.customerId, data: { source: 'settlement', eventId: 's1', provider: 'Sandbox Rail Settlements', grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: 'B-1' } });
      reconcile(state, finance());
      return held;
    });
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === line.id)!;
    renderApp('/exceptions?view=open&type=suspected_duplicate');
    const row = (await screen.findByText(String(exception.data.notes))).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/How was this resolved/);
    const outcome = () => within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    const generic = 'It does not allocate a payment, issue a refund, reissue a mandate or move money.';
    await user.selectOptions(code, 'same_payment');
    expect(outcome()).toContain('The next reconciliation joins this evidence to the payment this exception names');
    expect(outcome()).not.toContain(generic);
    await user.selectOptions(code, 'not_money');
    expect(outcome()).toContain('The next reconciliation sets this evidence aside for good');
    await user.selectOptions(code, 'distinct_payments');
    expect(outcome()).toContain('The next reconciliation records this evidence as a payment of its own.');
    await user.selectOptions(code, 'confirmed_duplicate_refund');
    expect(outcome()).toContain('The next reconciliation records this evidence as a payment of its own, held until its refund is recorded.');
    expect(outcome()).not.toContain(generic);

    await user.selectOptions(code, 'same_payment');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'The settlement file names the same collection.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve exception' })).toBeNull());
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toContain('Exception resolution recorded. The next reconciliation joins this payment evidence to payment PSK-SET-1 as more evidence of it: no second payment is made.');
    // The resolved exception leaves the open queue with its Resolve button, so reading continues from the answer.
    await waitFor(() => expect(screen.queryByText(String(exception.data.notes))).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(answer));
  });

  it('says what each resolution of a reversal waiting for its payment does, and shows the answer', async () => {
    const user = userEvent.setup();
    const reversal = api.mutate((state, ctx) => {
      const waiting = makeRecord(state, 'observations', { name: 'Unseen reversal', status: 'unresolved', reference: 'NEVER-SEEN-1', amountKobo: 500_000, customerId: '', data: { source: 'webhook', eventId: 'r1', provider: 'Sandbox Rail', reversed: true, occurredAt: new Date(Date.parse(api.now) - 3 * 86_400_000).toISOString() } });
      reconcile(state, { ...ctx, actor: 'Sandbox Finance', role: 'Finance' });
      return waiting;
    });
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === reversal.id)!;
    expect(exception.data.type).toBe('provider_status_mismatch');
    renderApp(`/exceptions?record=${exception.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/How was this resolved/);
    // Only the two codes that decide it are offered, each named for what it does to the reversal rather than by the
    // generic mismatch's labels, and the box says to leave the exception open while Finance checks.
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Provider state adopted; reversal waits for its payment', 'Platform state confirmed; reversal set aside for good']);
    expect(within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent).toContain('Leave this exception open while you check with the provider which collection the reversal reverses: if its payment arrives meanwhile, the reversal applies to it and this exception closes.');
    const outcome = () => within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    await user.selectOptions(code, 'provider_state_adopted');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Provider state adopted; reversal waits for its payment');
    expect(outcome()).toContain('The reversal keeps waiting for its payment, with no new exception: the reconciliation that records that payment reverses it');
    await user.selectOptions(code, 'platform_state_confirmed');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Platform state confirmed; reversal set aside for good');
    expect(outcome()).toContain('The next reconciliation sets the reversal aside for good: it reverses nothing, even if its payment arrives later.');
    expect(outcome()).not.toContain('It does not allocate a payment');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'The provider confirmed no such collection.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toMatch(/Exception resolution recorded\. This reversal evidence is set aside at the next reconciliation/);
    // Its Resolve button goes with the resolution, so focus moves to the answer; the exception, shown alone, names its resolution the same way.
    await waitFor(() => expect(document.activeElement).toBe(answer));
    expect(await screen.findByText('Resolution: Platform state confirmed; reversal set aside for good')).toBeTruthy();
  });

  it('keeps the generic labels and words for a provider status mismatch that is not a waiting reversal', async () => {
    const user = userEvent.setup();
    const mismatch = api.mutate((state, ctx) => raiseException(state, ctx, 'provider_status_mismatch', { notes: 'The provider shows the mandate active; the platform shows it pending activation.' }));
    renderApp(`/exceptions?record=${mismatch.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/How was this resolved/);
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Provider state adopted', 'Platform state confirmed', 'Escalated to provider']);
    await user.selectOptions(code, 'provider_state_adopted');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Provider state adopted');
    expect(within(dialog).getByText(/^Record outcome:/).parentElement!.textContent).toContain('It does not allocate a payment, issue a refund, reissue a mandate or move money.');
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
