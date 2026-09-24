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
