import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within } from "./harness";
import { fireEvent } from '@testing-library/react';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

describe("reports", () => {
  it('checks a selected source business date without backdating the financial close', async () => {
    const user = userEvent.setup();
    renderApp('/reports');
    await screen.findByText('No daily close yet');
    fireEvent.change(screen.getByLabelText('Source business date (optional)'), { target: { value: '2020-01-02' } });
    await user.click(screen.getByRole('button', { name: 'Run daily close' }));
    await screen.findByText('Daily close completed');
    const close = api.state().records.find(record => record.kind === 'closes')!;
    expect(close.data.sourceBusinessDate).toBe('2020-01-02');
    expect(close.data.closedAt.slice(0, 10)).not.toBe('2020-01-02');
    expect(close.data.reviewBasis.sourceCompleteness.businessDate).toBe('2020-01-02');
  });
  it("runs a daily close from the page and shows the REC-07 chips, the trigger and the schedule", async () => {
    const user = userEvent.setup();
    renderApp("/reports");
    expect(await screen.findByText("No daily close yet")).toBeTruthy();
    expect(screen.getByText(/^Next daily close: .+ WAT, then every day at this time\.$/)).toBeTruthy();
    expect(screen.getByText("Counts from the first daily close.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Run daily close" }));
    // The close is written by the real domain and read back through the reports contract.
    await user.click(await screen.findByText('View close details'));
    expect(await screen.findByText(/^manual$/)).toBeTruthy();
    const action = api.calls.find((call) => call.method === "POST" && call.path === "/v1/actions");
    expect(action?.body).toMatchObject({ action: "daily_close" });
    expect(action?.status).toBe(200);
    const closes = api.state().records.filter((record) => record.kind === "closes");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.data.schedule.trigger).toBe("manual");
    for (const label of ["Unmatched at start", "Payment records received", "Exceptions", "Retry decisions"]) expect(within(screen.getByRole("list", { name: "Recorded daily closes" })).getByText(label)).toBeTruthy();
    expect(screen.getByText(String(closes[0]!.data.summary))).toBeTruthy();
    expect(screen.getByText(/Since the first daily close on/)).toBeTruthy();
    expect(screen.queryByText("No daily close yet")).toBeNull();
  });

  it("says when the automatic close is off", async () => {
    api.mutate((state) => { state.settings.scheduledCloseEnabled = false; });
    renderApp("/reports");
    expect(await screen.findByText("Automatic daily close is off for this lender. Run closes manually.")).toBeTruthy();
  });

  it('distinguishes no accuracy measurement from a measured zero and offers the next action', async () => {
    renderApp('/reports');
    const accuracy = await screen.findByText('Accuracy of reviewed allocations');
    const card = accuracy.parentElement!;
    expect(within(card).getByText('Not measured yet')).toBeTruthy();
    expect(within(card).queryByText('0.0%')).toBeNull();
    expect(within(card).getByRole('link', { name: 'Review matches' }).getAttribute('href')).toBe('/reconciliation#precision-audit');
    expect(screen.getByText(/Current workspace totals.+All figures use sample data/)).toBeTruthy();
  });

  it('shows the daily-close failure and a safe way to check for a completed record before retrying', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, 'offline', 'POST');
    renderApp('/reports');
    await user.click(await screen.findByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Daily close could not be confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh close records' })).toBeTruthy();
    expect(api.state().records.filter(record => record.kind === 'closes')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Daily close completed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View close record' }).getAttribute('href')).toBe('/reports?view=operations#daily-closes');
  });

  it('invoices every month in order and names the month to issue first', async () => {
    api.setNow('2027-04-03T09:00:00.000Z');
    api.mutate(state => { const terms = state.records.find(record => record.kind === 'commercial')!; terms.data.signed = true; terms.data.effectiveDate = '2027-01-01'; });
    const user = userEvent.setup();
    renderApp('/reports?view=billing');
    expect(await screen.findByText(/^No invoice has been issued\. The next covers 2027-01\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the monthly invoice' });
    expect(within(dialog).getByText('Months are invoiced in order, a month with nothing to bill for zero. The next invoice covers 2027-01.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/^Invoice month/), '2027-03');
    await user.type(within(dialog).getByLabelText('Reason *'), 'Month-end invoice');
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));
    expect(await within(dialog).findByText(/issue the invoice for 2027-01 first, the month the signed terms took effect\.$/)).toBeTruthy();
    expect(api.state().records.some(record => record.kind === 'invoices')).toBe(false);
  });

  it('keeps billing exports reachable when the browser blocks the new tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.failNext(/^\/v1\/exports$/, 'offline', 'POST');
    renderApp('/reports?view=billing');
    await user.click(await screen.findByRole('button', { name: 'Export billing CSV' }));
    expect(await screen.findByText('Billing export request could not be confirmed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry original request' }));
    expect(await screen.findByRole('link', { name: 'Open billing CSV' })).toBeTruthy();
  });
});
