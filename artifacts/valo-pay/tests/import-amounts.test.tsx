import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { csvAmountToKobo, majorToMinor, minorToMajor, moneyText } from '@workspace/valopay-schema';
import { importCsv } from '../../api-server/src/lib/valopay-import';
import { ctxAt, wat } from '../../api-server/tests/helpers';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

describe('CSV amount units', () => {
  it('requires a source unit, shows naira, and requires another check when the unit changes', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'name,reference,amount,source,narration\nSample receipt,CSV-NAIRA,18000.50,webhook,Synthetic payment');
    expect(screen.getByRole('button', { name: 'Check data' })).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    const preview = screen.getByRole('heading', { name: /Parsed preview/ }).parentElement!;
    expect(within(preview).getByText('₦18,000.50')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'kobo');
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('₦18,000.50')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText(/Enter kobo as a whole number/);
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await waitFor(() => expect(api.state().records.find(record => record.reference === 'CSV-NAIRA')?.amountKobo).toBe(1800050));
  });

  it('shows a receipt of ₦0 as a row to fix and accepts a blank optional fee', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'name,reference,amount,source,feeKobo\nZero receipt,CSV-ZERO,0,webhook,\nBlank fee,CSV-BLANK-FEE,100.00,webhook,');
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    expect(await screen.findByText('0 imported · 0 skipped as duplicates · 1 row to fix · 1 valid row')).toBeTruthy();
    expect(screen.getByText(/Enter the amount received\. Payment evidence must be for more than ₦0\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    expect(api.state().records.some(record => ['CSV-ZERO', 'CSV-BLANK-FEE'].includes(record.reference))).toBe(false);
  });

  it('converts every row on the server, preserves exact decimals, and retains kobo API compatibility', () => {
    const ctx = ctxAt(wat('2027-07-01T09:00:00'), 'Admin');
    const input = { kind: 'observations', syntheticOnly: true, commit: true, csv: 'name,reference,amountKobo,source\nSample,CSV-KOBO,100050,webhook' };
    const state = structuredClone(api.state());
    expect(importCsv(state, ctx, input).imported).toBe(1);
    expect(state.records.find(record => record.reference === 'CSV-KOBO')?.amountKobo).toBe(100050);
    const naira = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,source\nSample,CSV-DECIMAL,"1,000.50",webhook' });
    expect(naira.preview[0]?.amountKobo).toBe(100050);
    expect(state.records.find(record => record.reference === 'CSV-DECIMAL')?.amountKobo).toBe(100050);
    const withFees = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,grossAmountKobo,feeKobo,source\nSample,CSV-FEES,980.50,1000.50,20.00,webhook' });
    expect(withFees.imported).toBe(1);
    expect(state.records.find(record => record.reference === 'CSV-FEES')?.data).toMatchObject({ grossAmountKobo: 100050, feeKobo: 2000 });
    const invalid = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,source\nValid,CSV-NOT-COMMITTED,1000,webhook\nInvalid,CSV-EXTRA-DECIMAL,1000.001,webhook' });
    expect(invalid.invalid).toBe(1);
    expect(invalid.imported).toBe(0);
    expect(state.records.some(record => record.reference === 'CSV-NOT-COMMITTED')).toBe(false);
  });

  it('rejects ambiguous, fractional kobo and unsafe values without floating-point rounding', () => {
    expect(csvAmountToKobo('90071992547409.91', 'naira')).toBe(Number.MAX_SAFE_INTEGER);
    expect(csvAmountToKobo('0.29', 'naira')).toBe(29);
    expect(csvAmountToKobo('0', 'kobo')).toBe(0);
    for (const value of ['', '-1', '1e3', '1.234', '1,00.50', '90071992547409.92']) expect(() => csvAmountToKobo(value, 'naira')).toThrow();
    for (const value of ['', '-1', '1e3', '100.50', '100,000', '9007199254740992']) expect(() => csvAmountToKobo(value, 'kobo')).toThrow();
  });

  // Fourth review: amounts in major units were multiplied by 100 whatever the row's currency, so JPY 1000 was stored as
  // 100000 and KWD 1.5 as 150. Each row's currency now gives its decimals, by ISO 4217.
  it('converts major units with each row\'s currency decimals and refuses more decimals than the currency has', () => {
    const ctx = ctxAt(wat('2027-07-01T09:00:00'), 'Admin');
    const state = structuredClone(api.state());
    const run = (csv: string) => {
      const rows = csv.split('\n').length - 1;
      return importCsv(state, ctx, { kind: 'observations', syntheticOnly: true, commit: true, amountUnit: 'naira', csv, identities: { source: 'currency-rows', batchId: `currency-${csv.length}`, ids: Array.from({ length: rows }, (_, index) => `${csv.length}-${index}`) } });
    };
    const imported = run('name,reference,amount,source,currency\nYen,CSV-JPY,"1,000",card,JPY\nDinar,CSV-KWD,1.5,card,KWD\nDollars,CSV-USD,10.00,card,usd\nFomento,CSV-CLF,0.0001,card,CLF\nNaira,CSV-NGN,"1,000.50",card,');
    expect([imported.imported, imported.invalid]).toEqual([5, 0]);
    const stored = (reference: string) => state.records.find(record => record.reference === reference)!;
    expect(['CSV-JPY', 'CSV-KWD', 'CSV-USD', 'CSV-CLF', 'CSV-NGN'].map(reference => stored(reference).amountKobo)).toEqual([1000, 1500, 1000, 1, 100050]);
    expect(['CSV-JPY', 'CSV-KWD'].map(reference => moneyText(stored(reference).amountKobo, String(stored(reference).data.currency)))).toEqual(['JPY 1,000', 'KWD 1.500']);
    const refused = run('name,reference,amount,source,currency\nYen,CSV-JPY-HALF,1000.5,card,JPY\nDinar,CSV-KWD-MORE,1.2345,card,KWD\nGold,CSV-XAU,1.5,card,XAU\nDollars,CSV-USD-OK,10.00,card,USD');
    expect([refused.imported, refused.invalid]).toEqual([0, 3]);
    expect(refused.rows.map(row => row.message).slice(0, 3)).toEqual([
      expect.stringMatching(/JPY with no decimal places/),
      expect.stringMatching(/KWD with no more than 3 decimal places/),
      expect.stringMatching(/XAU.*minor unit/),
    ]);
    // The minor units a row states are taken as they are, whatever its currency.
    const minor = importCsv(state, ctx, { kind: 'observations', syntheticOnly: true, commit: true, amountUnit: 'kobo', csv: 'name,reference,amount,source,currency\nYen,CSV-JPY-MINOR,1000,card,JPY', identities: { source: 'currency-rows', batchId: 'minor', ids: ['minor-1'] } });
    expect([minor.imported, stored('CSV-JPY-MINOR').amountKobo]).toEqual([1, 1000]);
  });

  // The preview is where the conversion is checked before importing, so each amount shows in its row's currency.
  it('previews each converted amount in its row\'s currency', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'name,reference,amount,source,currency\nYen,CSV-JPY,1000,card,JPY\nDollars,CSV-USD,10.00,card,usd\nNaira,CSV-NGN,18000.50,card,');
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    const preview = screen.getByRole('heading', { name: /Parsed preview/ }).parentElement!;
    expect(within(preview).getByRole('columnheader', { name: 'Amount to import' })).toBeTruthy();
    expect(within(preview).getAllByRole('row').slice(1).map(row => row.lastElementChild?.textContent)).toEqual(['JPY\u00a01,000', 'USD\u00a010.00', '₦18,000.50']);
    expect(document.getElementById('import-unit-help')?.textContent).toMatch(/The preview shows each converted amount in its currency\.$/);
    expect(within(preview).getByText(/^Source amounts: Major units \(₦, or the row's currency\)\./)).toBeTruthy();
  });

  it('reads and writes a form amount in its currency\'s major unit exactly', () => {
    expect([majorToMinor('1,000', 'JPY'), majorToMinor('1.5', 'kwd'), majorToMinor('1,000.50', 'USD'), majorToMinor('1,000.50'), majorToMinor('90071992547409.91', 'USD')]).toEqual([1000, 1500, 100050, 100050, Number.MAX_SAFE_INTEGER]);
    for (const [value, currency] of [['1.5', 'JPY'], ['1.2345', 'KWD'], ['1.234', 'USD'], ['1', 'XAU'], ['-1', 'USD'], ['9007199254740992', 'JPY']]) expect(() => majorToMinor(value!, currency)).toThrow();
    expect([minorToMajor(1000, 'JPY'), minorToMajor(1500, 'KWD'), minorToMajor(100050, 'USD'), minorToMajor(100050), minorToMajor(1, 'CLF')]).toEqual(['1000', '1.500', '1000.50', '1000.50', '0.0001']);
  });
});
