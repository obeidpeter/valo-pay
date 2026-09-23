import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRecord } from '../../api-server/src/domain';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { fireEvent } from '@testing-library/react';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

describe('evidence register and operational reviews', () => {
  it('keeps evidence for every decision visible, searchable and editable after saving', async () => {
    const user = userEvent.setup();
    api.mutate((state, ctx) => {
      for (const gateId of ['P1', 'F1', 'F2', 'F3', 'F4', 'T1b', 'T2']) makeRecord(state, 'evidence', {
        name: `${gateId} sample evidence`, status: 'recorded', createdAt: ctx.now,
        data: { gateId, reference: `sample-${gateId}`, owner: 'Adéyẹmí', evidenceDate: '2026-09-01', notes: 'Sample document reference' },
      });
    });
    renderApp('/evidence');
    const register = await screen.findByRole('region', { name: 'Evidence register' });
    expect(await within(register).findByText('T2 sample evidence')).toBeTruthy();
    for (const gate of ['F1', 'F2', 'F3', 'F4', 'T1b']) expect(within(register).getByText(`${gate} sample evidence`)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Search evidence' }), 'ADEYEMI');
    expect(within(register).getByText('T2 sample evidence')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter evidence by requirement' }), 'T2');
    expect(within(register).queryByText('F1 sample evidence')).toBeNull();
    await user.click(within(register).getByRole('button', { name: 'Edit evidence: T2 sample evidence' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByRole('textbox', { name: /^Evidence title/ });
    await user.clear(title); await user.type(title, 'Updated recovery evidence');
    await user.click(within(dialog).getByRole('button', { name: /Save/ }));
    expect(await within(register).findByText('Updated recovery evidence')).toBeTruthy();
    expect(api.state().records.find(record => record.name === 'Updated recovery evidence')?.data.gateId).toBe('T2');
    expect(screen.getByText('Requirements missing')).toBeTruthy();
  });

  it('records when signed terms take effect, the month from which they bill', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(await within(section).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    expect(within(dialog).getByText(/^Each invoice month is billed from the latest signed terms in effect by its end, for the whole month\./)).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: /^Signed/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Takes effect on/), { target: { value: '2027-07-15' } });
    await user.click(within(dialog).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.state().records.find(record => record.kind === 'commercial')?.data).toMatchObject({ signed: true, effectiveDate: '2027-07-15' }));
  });

  it('shows load failures instead of saying commercial commitments and reviews are empty', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/commercial$/, { status: 503, error: 'Service temporarily unavailable.' });
    api.failNext(/^\/v1\/records\/reviews$/, 'offline');
    renderApp('/evidence');
    const commercial = await screen.findByText('Unable to load commercial commitments');
    const reviews = await screen.findByText('Unable to load reviews');
    expect(screen.queryByText('No commercial commitments')).toBeNull();
    expect(screen.queryByText('No reviews logged')).toBeNull();
    await user.click(within(commercial.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' }));
    await user.click(within(reviews.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Unable to load commercial commitments')).toBeNull());
    expect(await screen.findByText('No reviews logged')).toBeTruthy();
  });

  it('reports export failures and leaves an Open link when the browser blocks the new tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.failNext(/^\/v1\/exports$/, 'offline', 'POST');
    renderApp('/evidence');
    const exportButton = await screen.findByRole('button', { name: 'Export evidence pack' });
    await user.click(exportButton);
    expect(await screen.findByText('Evidence pack request could not be confirmed')).toBeTruthy();
    expect(exportButton.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Retry original request' }));
    const link = await screen.findByRole('link', { name: 'Open evidence pack' });
    expect(link.getAttribute('href')).toMatch(/\/exports\//);
    expect(window.open).toHaveBeenCalledWith(link.getAttribute('href'), '_blank');
  });

  it('saves the named tasks and review date, keeping partial reviews distinct from complete reviews', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    await user.click(await screen.findByRole('button', { name: 'Log review' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Choose the date the review took place.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Review date'), '2026-09-01');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mandate operations' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Payment matching' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Review notes' }), 'Checked mandates and matches; retries and dispute records still need review.');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const record = api.state().records.find(record => record.kind === 'reviews');
    expect(record?.data).toMatchObject({ confirmedJobs: ['mandates', 'reconciliation'], reviewedAt: '2026-09-01' });
    expect(await screen.findByText('Mandate operations, Payment matching')).toBeTruthy();
    expect(screen.getByText('Review recorded')).toBeTruthy();
  });
});
