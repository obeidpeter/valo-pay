import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

describe('section deep links', () => {
  it('waits for report data before focusing and revealing the requested daily-close section', async () => {
    const release = api.hold(/^\/v1\/reports$/);
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this); });
    renderApp('/reports#daily-closes');
    await screen.findByText('Loading reports…');
    expect(document.getElementById('daily-closes')).toBeNull();
    release();
    const section = await screen.findByRole('region', { name: 'Daily close records' });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(scrolled).toContain(section);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  });

  it('follows the Reports accuracy link through client navigation and delayed allocation data', async () => {
    const user = userEvent.setup();
    const release = api.hold(/^\/v1\/records\/allocations$/);
    renderApp('/reports');
    await user.click(await screen.findByRole('link', { name: 'Review matches' }));
    expect(window.location.hash).toBe('#precision-audit');
    const section = await screen.findByRole('region', { name: 'Match accuracy review' });
    expect(document.activeElement).not.toBe(section);
    release();
    await waitFor(() => expect(document.activeElement).toBe(section));
  });

  it('opens a landing section from a shared URL without loading a workspace', async () => {
    renderApp('/#pilot');
    const section = screen.getByRole('region', { name: 'See how Valo Pay fits your team.' });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(api.calls).toEqual([]);
  });
});
