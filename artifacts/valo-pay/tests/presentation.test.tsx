import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, within } from './harness';
import { presentationSamples } from '@/lib/presentation';
import { seedMerchant } from '../../api-server/src/lib/valopay-seed';
import { saveImportBatch, commitImportBatch } from '../../api-server/src/domain/pilot-workflow';
import { reconcile } from '../../api-server/src/domain/reconciliation';

let api: FakeApi;
beforeEach(() => { sessionStorage.clear(); api = installFakeApi(); });
afterEach(() => { api.uninstall(); sessionStorage.clear(); });

it('keeps presentation controls separate from platform actions and resumes after navigation and reload', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  let guide = screen.getByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText(/Show presenter notes/).closest('details')?.open).toBe(false);
  await user.click(within(guide).getByRole('link', { name: 'Open overview' }));
  await screen.findByRole('heading', { name: 'Operations overview' });
  expect(screen.queryByRole('region', { name: 'Sandbox guide' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(window.location.pathname).toBe('/overview');
  cleanup();
  renderApp('/overview');
  guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('2 of 6 · Bring in payment evidence')).toBeTruthy();
  await user.click(within(guide).getByRole('link', { name: 'Open import batches' }));
  await screen.findByRole('heading', { name: 'Import batches' });
  await user.click(screen.getByRole('button', { name: 'End presentation' }));
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('separates preparation by lender and clearing checkboxes preserves all records', async () => {
  const user = userEvent.setup(), before = structuredClone(api.state());
  renderApp('/presentation');
  const check = await screen.findByRole('checkbox', { name: /I chose one sample lender/ });
  await user.click(check);
  await user.click(screen.getByRole('button', { name: 'Start presentation guide' }));
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(screen.getByText('0 of 6 preparation checks marked')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[0]!);
  expect(screen.getByText('1 of 6 preparation checks marked')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Clear preparation checks' }));
  expect(screen.getByText('0 of 6 preparation checks marked')).toBeTruthy();
  expect(api.state()).toEqual(before);
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('ignores malformed saved state and works when browser storage is unavailable', async () => {
  const key = `valopay-presentation-v1:${JSON.stringify(['Sandbox Admin', api.merchantIds[0]])}`;
  sessionStorage.setItem(key, JSON.stringify({ active: true, step: 999, checked: ['build'] }));
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('button', { name: 'Start presentation guide' });
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  cleanup();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  expect(screen.getByRole('region', { name: 'Presentation guide' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(screen.getByText('2 of 6 · Bring in payment evidence')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('imports the exact sample pack through batch validation, links the payment and refuses duplicate ingestion', () => {
  const state = seedMerchant('presentation-fixture', true);
  const ctx = { actor: 'Presentation rehearsal', role: 'Admin', now: '2026-09-22T10:00:00.000Z' };
  const kinds = ['customers', 'due-items', 'observations'] as const;
  presentationSamples('2026-09-22').forEach((sample, index) => {
    const input = { name: sample.kind, kind: kinds[index]!, source: 'Presentation sample', sourceBatchId: sample.filename, businessDate: '2026-09-22', identityColumn: 'source_row_id', amountUnit: 'naira' as const, syntheticOnly: true as const, mapping: {}, csv: sample.csv };
    const batch = saveImportBatch(state, ctx, input);
    expect(batch.data.check.invalid, JSON.stringify(batch.data.check)).toBe(0);
    expect(batch.status).toBe('ready');
    const result = commitImportBatch(state, ctx, batch.id, batch.updatedAt);
    expect(result.data.check.imported).toBe(1);
    const repeated = saveImportBatch(state, ctx, { ...input, sourceBatchId: `${sample.filename}-repeat` });
    expect(repeated.data.check.skipped).toBe(1);
    expect(repeated.data.check.valid).toBe(0);
  });
  const customer = state.records.find(r => r.reference === 'PRES-C001')!;
  const due = state.records.find(r => r.reference === 'PRES-D001')!;
  const observation = state.records.find(r => r.reference === 'PRES-O001')!;
  expect(due.amountKobo).toBe(1_800_050);
  expect(observation.amountKobo).toBe(due.amountKobo);
  expect(observation.customerId).toBe(customer.id);
  expect(observation.data.dueItemId).toBe(due.id);
  reconcile(state, ctx);
  expect(observation.status).toBe('resolved');
  expect(state.records.some(r => r.kind === 'allocations' && r.data.dueItemId === due.id && r.amountKobo === 1_800_050)).toBe(true);
});
