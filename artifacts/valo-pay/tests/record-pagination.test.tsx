import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('large customer directory', () => {
  it('requests and renders bounded pages from 10,000 customers, then searches beyond the first page', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'customers')!;
      state.records = state.records.filter(record => record.kind !== 'customers');
      state.records.push(...Array.from({ length: 10_000 }, (_, index) => ({
        ...sample, id: randomUUID(), name: `Scale customer ${String(index).padStart(5, '0')}`, reference: `SCALE-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })));
    });
    renderApp('/customers');
    await screen.findByText('Scale customer 09999');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    const pages = screen.getByRole('navigation', { name: 'customers pagination' });
    expect(pages.textContent).toContain('1–25 of 10,000 customers');
    await user.click(within(pages).getByRole('button', { name: 'Next page of customers' }));
    await screen.findByText('Scale customer 09974');
    expect(screen.queryByText('Scale customer 09999')).toBeNull();
    const calls = () => api.calls.filter(call => call.path === '/v1/records/customers');
    expect(calls().map(call => [call.query.limit, call.query.offset])).toEqual([['25', '0'], ['25', '25']]);
    const beforeSearch = calls().length;
    // The keys go in without yielding to timers, so however busy the machine, the search's pause cannot end
    // between two of them and the whole text goes out as one search. The pause itself is pinned, on a fake
    // clock, in search-pause.test.ts.
    const typist = userEvent.setup({ delay: null });
    await typist.type(screen.getByRole('textbox', { name: 'Search customers' }), 'Scale customer 00001');
    await screen.findByText('Scale customer 00001');
    expect(calls().length - beforeSearch).toBe(1);
    expect(calls().at(-1)?.query).toMatchObject({ limit: '25', offset: '0', search: 'Scale customer 00001' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByRole('textbox', { name: 'Search customers' }));
    await screen.findByText('Scale customer 09999');
    await user.selectOptions(screen.getByRole('combobox', { name: 'customers per page' }), '100');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101));
    expect(calls().at(-1)?.query).toMatchObject({ limit: '100', offset: '0' });
  });

  it('retries a failed customer request in place without claiming the directory is empty', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/customers$/, { status: 503, error: 'Directory temporarily unavailable.' });
    renderApp('/customers');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Unable to load customers');
    expect(screen.queryByText('No customers yet')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Ada Okonkwo');
  });
});

// Second review of the audit fixes, the older focus patterns: paging by keyboard keeps focus on the pager control
// pressed (or on the one still usable at the first or last page), never on the page body or the top of a dialog.
describe('paging by keyboard', () => {
  const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };
  /** Sixty customers, the newest first: Pager customer 59 heads the first page and Pager customer 00 ends the last. */
  const sixtyCustomers = () => api.mutate(state => {
    const sample = state.records.find(record => record.kind === 'customers')!;
    state.records = state.records.filter(record => record.kind !== 'customers');
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({
      ...sample, id: randomUUID(), name: `Pager customer ${String(index).padStart(2, '0')}`, reference: `PAGER-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    })));
  });

  it('keeps focus on Next while the next page of customers loads, and moves it to Previous on the last page', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    renderApp('/customers');
    await screen.findByText('Pager customer 59');
    const pages = screen.getByRole('navigation', { name: 'customers pagination' });
    const next = within(pages).getByRole('button', { name: 'Next page of customers' });
    const release = api.hold(/^\/v1\/records\/customers$/);
    await press(user, next);
    // The rows and the pager stay while the page loads; the pressed button keeps the focus and waits.
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    expect(screen.getByText('Pager customer 59')).toBeTruthy();
    release();
    await screen.findByText('Pager customer 34');
    expect(document.activeElement).toBe(next);
    await press(user, next);
    await screen.findByText('Pager customer 00');
    expect(document.activeElement).toBe(within(pages).getByRole('button', { name: 'Previous page of customers' }));
    const size = within(pages).getByRole('combobox', { name: 'customers per page' });
    size.focus();
    await user.selectOptions(size, '50');
    await screen.findByText('Pager customer 59');
    expect(document.activeElement).toBe(size);
  });

  it('keeps focus on Next while the next page of audit entries loads', async () => {
    api.mutate(state => {
      const source = state.records.find(record => record.kind === 'audit')!;
      for (let index = 0; index < 60; index++) state.records.push({ ...structuredClone(source), id: `extra-audit-${index}`, name: `Sample event ${index}`, data: { ...source.data, summary: `Sample event ${index}` } });
    });
    const user = userEvent.setup();
    renderApp('/audit');
    await screen.findByRole('table');
    const total = api.state().records.filter(record => record.kind === 'audit').length;
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThanOrEqual(75);
    const next = screen.getByRole('button', { name: 'Next page of audit entries' });
    const release = api.hold(/^\/v1\/records\/audit$/);
    await press(user, next);
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    release();
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    expect(api.calls.some(call => call.path === '/v1/records/audit' && call.query.offset === '25')).toBe(true);
    expect(document.activeElement).toBe(next);
    await press(user, next);
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/audit' && call.query.offset === '50')).toBe(true));
    // The last page: Next has nowhere to go, so Previous takes the focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous page of audit entries' })));
  });

  it('gives the focus back to the picker pager control pressed once the next page of customer choices arrives', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Create synthetic mandate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    await within(dialog).findByText('1–25 of 60 customer choices');
    await press(user, within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await within(dialog).findByText('26–50 of 60 customer choices');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await press(user, within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await within(dialog).findByText('51–60 of 60 customer choices');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Previous page of customer choices' }));
  });

  it('gives the focus back to the allocation picker pager control pressed once the next page of instalment choices arrives', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(due), id: randomUUID(), reference: `PAGER-DUE-${index}` })));
    });
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    const pager = await within(dialog).findByRole('navigation', { name: 'instalment choices pagination' });
    const total = Number(within(pager).getByText(/^1–25 of \d+ instalment choices$/).textContent!.match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThan(50);
    await press(user, within(pager).getByRole('button', { name: 'Next page of instalment choices' }));
    await within(dialog).findByText(`26–50 of ${total} instalment choices`);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next page of instalment choices' }));
  });
});
