import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ role: 'Compliance reviewer' }); });
afterEach(() => api.uninstall());

describe('policy and template review', () => {
  it('separates policy and template failures and lets each request be retried', async () => {
    api.failNext(/^\/v1\/records\/policies$/, { status: 503, error: 'Policies temporarily unavailable.' });
    api.failNext(/^\/v1\/records\/templates$/, { status: 503, error: 'Templates temporarily unavailable.' });
    const user = userEvent.setup();
    renderApp('/policies');
    const policyAlert = (await screen.findByText('Unable to load retry policies')).closest('[role="alert"]')!;
    const templateAlert = (await screen.findByText('Unable to load notification templates')).closest('[role="alert"]')!;
    expect(screen.queryByText('No retry policies yet')).toBeNull();
    expect(screen.queryByText('No notification templates yet')).toBeNull();
    await user.click(within(policyAlert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Version 1');
    expect(screen.getByText('Unable to load notification templates')).toBeTruthy();
    await user.click(within(templateAlert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await screen.findByText(/Example Lender: Your payment of ₦25,000.00/);
  });

  it('shows changed limits, spacing and both notice periods before a policy is approved', async () => {
    api.mutate(state => {
      const previous = state.records.find(record => record.kind === 'policies')!;
      previous.status = 'approved';
      state.records.push({ ...structuredClone(previous), id: 'policy-next', status: 'submitted', data: { ...previous.data, version: 2, previousVersionId: previous.id, maxAttempts: 4, spacingHours: 72, firstNoticeHours: 72, retryNoticeHours: 48 } });
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve policy' });
    expect(within(dialog).getByText(/Previous version: 1/)).toBeTruthy();
    expect(within(dialog).getAllByText('Changed')).toHaveLength(4);
    expect(within(dialog).getByText('This version: 4')).toBeTruthy();
    expect(within(dialog).getAllByText('This version: 72 hours')).toHaveLength(2);
    expect(within(dialog).getByText('This version: 48 hours')).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: Your retry rules allow up to 4 attempts/)).toBeTruthy();
    expect(api.calls.some(call => (call.body as { action?: string })?.action === 'approve_policy')).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason *'), 'Reviewed changes and notice periods.');
    await user.click(within(dialog).getByRole('button', { name: 'Approve policy' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === 'policy-next')?.status).toBe('approved'));
  });

  it('renders previous and proposed message wording with synthetic values before approval', async () => {
    api.mutate(state => {
      const previous = state.records.find(record => record.kind === 'templates')!;
      previous.status = 'approved';
      state.records.push({ ...structuredClone(previous), id: 'template-next', status: 'submitted', data: { ...previous.data, version: 2, previousVersionId: previous.id, text: '{{merchant}}: We plan to collect {{amount}} on {{date}}. Need help? {{contact}}.' } });
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve template' });
    expect(within(dialog).getByText(/Previous version: 1/)).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: Your payment of ₦25,000.00 is due on 25 September 2026/)).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: We plan to collect ₦25,000.00 on 25 September 2026/)).toBeTruthy();
    expect(within(dialog).getByText('This version — message changed')).toBeTruthy();
    expect(api.calls.some(call => (call.body as { action?: string })?.action === 'approve_template')).toBe(false);
  });

  it('does not invent a baseline when a linked prior version is missing', async () => {
    api.mutate(state => {
      const policy = state.records.find(record => record.kind === 'policies')!;
      policy.status = 'submitted';
      policy.data.previousVersionId = 'unavailable-version';
      policy.data.version = 2;
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve policy' });
    expect(within(dialog).getByText(/The linked previous version is unavailable/)).toBeTruthy();
    expect(within(dialog).queryByText('Changed')).toBeNull();
  });

  it('creates a linked draft successor through the existing version action', async () => {
    api.role = 'Admin';
    api.mutate(state => { state.records.find(record => record.kind === 'policies')!.status = 'approved'; });
    const previous = api.state().records.find(record => record.kind === 'policies')!;
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Draft next version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Draft next policy version' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Prepare the next review.');
    await user.click(within(dialog).getByRole('button', { name: 'Create draft version' }));
    await screen.findByText('Version 2');
    expect(api.state().records.find(record => record.kind === 'policies' && record.data.version === 2)?.data.previousVersionId).toBe(previous.id);
  });

  it('updates the synthetic template preview while editing without interpreting markup', async () => {
    api.role = 'Admin';
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit template' });
    const text = within(dialog).getByLabelText(/Message \(include/);
    await user.clear(text);
    await user.paste('<script>sample</script> {{merchant}}');
    expect(within(dialog).getByText('<script>sample</script> Example Lender')).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
  });
});
