import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('effective daily-close status', () => {
  it.each(['/overview', '/reports', '/settings'])('shows manual-only service status at %s even when the lender requested scheduling', async (path) => {
    api.scheduler.state = 'off';
    renderApp(path);
    expect(await screen.findByText('Automatic daily close is off on this service. Run closes manually.')).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
    expect(api.state().settings.scheduledCloseEnabled).toBe(true);
  });

  it('keeps saving a requested schedule distinct from starting the service', async () => {
    const user = userEvent.setup();
    api.scheduler.state = 'off';
    renderApp('/settings');
    await screen.findByText('Automatic daily close is off on this service. Run closes manually.');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Saving it does not start the service/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Automatic daily close is off on this service. Run closes manually.')).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('shows a failed service check with a recovery action rather than promising an automatic run', async () => {
    api.scheduler.lastErrorAt = api.now;
    renderApp('/reports');
    expect(await screen.findByText(/The automatic close service could not complete its latest check/)).toBeTruthy();
    expect(screen.getByText(/^Last failed service check:/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Run daily close' })).toBeTruthy();
  });

  it('does not present a stale service check as a confirmed future close', async () => {
    api.scheduler.lastSuccessAt = new Date(Date.parse(api.now) - 300_000).toISOString();
    renderApp('/overview');
    expect(await screen.findByText(/The automatic close service has stopped checking on time/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('labels a close waiting to run as due instead of calling it a future run', async () => {
    api.mutate(state => { state.settings.nextCloseAt = new Date(Date.parse(api.now) - 120_000).toISOString(); });
    renderApp('/overview');
    expect(await screen.findByText(/Daily close was due .+ Waiting for the automatic close service/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('explains an automatic close paused because nobody changed the sandbox', async () => {
    api.mutate(state => { state.settings.scheduledCloseEnabled = false; state.settings.closePausedForInactivityAt = api.now; });
    renderApp('/settings');
    expect(await screen.findByText(/Automatic daily close paused on .+ because nobody changed this sandbox for 7 days/)).toBeTruthy();
    expect(screen.queryByText('Automatic daily close is off for this lender. Run closes manually.')).toBeNull();
  });

  it('shows a failing automatic close with its next attempt instead of only calling it missed', async () => {
    api.mutate(state => {
      const cursor = new Date(Date.parse(api.now) - 40 * 60_000).toISOString();
      state.settings.nextCloseAt = cursor;
      state.settings.closeRetry = { cursor, failures: 3, retryAt: new Date(Date.parse(api.now) + 8 * 60_000).toISOString(), lastFailedAt: api.now };
    });
    renderApp('/overview');
    expect(await screen.findByText(/The automatic close for this lender failed 3 times\. Next attempt: .+ Run a daily close manually/)).toBeTruthy();
    expect(screen.queryByText(/^Scheduled close at .+ missed/)).toBeNull();
  });
});
