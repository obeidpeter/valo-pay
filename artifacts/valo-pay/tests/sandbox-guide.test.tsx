import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('guided sandbox exploration', () => {
  it('lets people navigate, record progress and dismiss without performing an operation', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    const guide = await screen.findByRole('region', { name: 'Sandbox guide' });
    expect(within(guide).getByText('Step 1 of 5 · Sample data only')).toBeTruthy();
    await user.click(within(guide).getByRole('button', { name: "I've completed this step" }));
    expect(within(guide).getByRole('link', { name: 'Review proposed matches' }).getAttribute('href')).toBe('/reconciliation?view=review');
    await user.click(within(guide).getByRole('link', { name: 'Review proposed matches' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reconciliation' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Sandbox guide' })).getByText('Step 2 of 5 · Sample data only')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss sandbox guide' }));
    expect(screen.queryByRole('region', { name: 'Sandbox guide' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    await user.click(await screen.findByRole('button', { name: 'Open sandbox guide' }));
    expect(screen.getByText('Step 2 of 5 · Sample data only')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('keeps progress scoped to the selected lender and treats a completed guide only as personal progress', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('region', { name: 'Sandbox guide' });
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: "I've completed this step" }));
    expect(screen.getByText(/does not confirm that operational tasks or readiness checks passed/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
    await waitFor(() => expect(screen.getByText('Step 1 of 5 · Sample data only')).toBeTruthy());
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });
});
