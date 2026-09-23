import { afterEach, beforeEach, expect, it } from 'vitest';
import { screen, userEvent, waitFor, renderApp, within } from './harness';
import { installFakeApi, type FakeApi } from './fake-api';
import { makeRecord } from '../../api-server/src/domain/records';
import { lifecyclePolicy, lifecycleHolds, saveLifecyclePolicy, setLifecycleHold } from '../../api-server/src/domain/lifecycle';

let api: FakeApi, batchId: string;
beforeEach(() => {
  api = installFakeApi({ now: '2026-09-25T10:00:00.000Z' });
  batchId = api.mutate(state => makeRecord(state, 'import-batches', { name: 'Aged sample import', status: 'committed', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', data: { csv: 'reference,name\nSAMPLE-ROW,Sample customer', committedAt: '2026-08-01T10:00:00.000Z', rowIds: ['source-1'], recordIds: ['original-record'], check: { valid: 1, invalid: 0, imported: 1, rows: [], preview: [{ row: 1, values: { reference: 'SAMPLE-ROW' } }] } } }).id);
});
afterEach(() => api.uninstall());
function enable() { api.mutate((state, ctx) => saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'The sample source has passed its retention review.' })); }
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Prepare deletion preview' }));
  await screen.findByRole('heading', { name: 'Review exact deletion candidates' });
}
async function approve(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('checkbox', { name: /I reviewed every source identity/ }));
  await user.type(screen.getByRole('textbox', { name: 'Reason for approving this deletion' }), 'Approved the exact synthetic source after checking the hold rules.');
  await user.click(screen.getByRole('button', { name: 'Approve exact deletion run' }));
}

it('starts disabled and requires a policy, exact preview and explicit approval before raw source deletion', async () => {
  const user = userEvent.setup(); renderApp('/lifecycle');
  const start = await screen.findByRole('button', { name: 'Prepare deletion preview' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: 'Raw CSV after import' }));
  await user.type(screen.getByRole('textbox', { name: 'Reason for the policy change' }), 'Retain this committed sample source for at least thirty days.');
  await user.click(screen.getByRole('button', { name: 'Save retention policy' }));
  await screen.findByText('Retention policy saved. Saving a policy does not delete data.');
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare deletion preview' }) as HTMLButtonElement).disabled).toBe(false));
  await prepare(user);
  expect((screen.getByRole('button', { name: 'Approve exact deletion run' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('list', { name: 'Exact sources in this deletion preview' }).textContent).toContain(batchId);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  await approve(user);
  await screen.findByRole('button', { name: 'Execute approved run' });
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  const financial = JSON.stringify(api.state().records.filter(record => ['customers', 'payments', 'allocations', 'due-items'].includes(record.kind)));
  await user.click(screen.getByRole('button', { name: 'Execute approved run' }));
  await screen.findByRole('heading', { name: 'Saved deletion receipts' });
  const saved = api.state().records.find(record => record.id === batchId)!;
  expect(saved.data.csv).toBeUndefined();
  expect(saved.data.check.preview).toBeUndefined();
  expect(saved.data.rowIds).toEqual(['source-1']);
  expect(saved.status).toBe('committed');
  expect(JSON.stringify(api.state().records.filter(record => ['customers', 'payments', 'allocations', 'due-items'].includes(record.kind)))).toBe(financial);
  expect(api.state().records.filter(record => record.kind === 'retention-receipts' && record.data.result === 'deleted')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Execute approved run' })).toBeNull();
});

it('blocks approval after another administrator places a hold on the previewed source', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user);
  api.mutate((state, ctx) => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: batchId, held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'This source is needed for a new sample investigation.' }));
  await approve(user);
  await screen.findByText(/A previewed source changed, is held or is no longer eligible/);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  expect(api.state().records.filter(record => record.kind === 'retention-receipts')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Execute approved run' })).toBeNull();
});

it('recovers an execution whose committed response was lost using the identical request identity', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  await screen.findByRole('button', { name: 'Execute approved run' });
  const baseFetch = globalThis.fetch;
  let lose = true;
  const requests: Array<{ body: string; key: string }> = [], saved = new Map<string, Response>();
  globalThis.fetch = async (input, options) => {
    if (!String(input).includes('/execute')) return baseFetch(input, options);
    const key = new Headers(options?.headers).get('Idempotency-Key')!;
    requests.push({ key, body: String(options?.body) });
    if (saved.has(key)) return saved.get(key)!.clone();
    const response = await baseFetch(input, options);
    if (response.ok) saved.set(key, response.clone());
    if (response.ok && lose) { lose = false; throw new TypeError('Lost response after deletion receipt committed'); }
    return response;
  };
  await user.click(screen.getByRole('button', { name: 'Execute approved run' }));
  await screen.findByText('Outcome not confirmed');
  expect((screen.getByRole('button', { name: 'Execute approved run' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Check original request' }));
  await screen.findByRole('heading', { name: 'Saved deletion receipts' });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(api.state().records.filter(record => record.kind === 'retention-receipts')).toHaveLength(1);
});

it('keeps retention details and controls unavailable to non-administrators', async () => {
  api.role = 'Finance'; renderApp('/lifecycle');
  await screen.findByText(/Only a currently authorised administrator can inspect or change retention controls/);
  expect(screen.queryByRole('button', { name: 'Save retention policy' })).toBeNull();
  expect(api.calls.filter(call => call.path === '/v1/lifecycle')).toHaveLength(0);
});

it('lets an administrator place an exact artifact hold with an accountable reason', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  const target = await screen.findByRole('combobox', { name: 'Source to hold or release' });
  await user.selectOptions(target, `raw_csv:${batchId}`);
  await user.type(screen.getByRole('textbox', { name: 'Reason for the hold decision' }), 'Preserve this source while a sample case is reviewed.');
  await user.click(screen.getByRole('button', { name: 'Place a hold' }));
  await screen.findByText('Retention hold updated. Every deletion checks current holds.');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare deletion preview' }) as HTMLButtonElement).disabled).toBe(true));
  expect(api.state().records.filter(record => record.kind === 'retention-holds' && record.data.held)).toHaveLength(1);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
});

it('says why an export file kept as evidence is never offered for deletion', async () => {
  api.mutate((state, ctx) => saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: 30, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Sample sources and files have passed their retention review.' }));
  const exportId = api.mutate(state => makeRecord(state, 'exports', { name: 'Sample customer pack', status: 'ready', createdAt: '2026-08-02T10:00:00.000Z', data: { kind: 'customer-pack', format: 'json', bucket: 'synthetic-private', objectName: 'exports/sample.json', checksum: 'c'.repeat(64), generatedAt: '2026-08-02T10:00:00.000Z' } }).id);
  const caseId = api.mutate(state => makeRecord(state, 'exceptions', { name: 'Open sample case', status: 'in_progress', createdAt: '2026-08-02T10:00:00.000Z', data: { type: 'unmatched_payment', case: { assignee: 'Sandbox Admin', assigneeName: 'Sandbox Admin', nextAction: 'Review the linked export', nextActionAt: '2026-10-01T10:00:00.000Z', evidenceIds: [exportId] } } }).id);
  api.lifecycleExternal = [{ kind: 'export_file', merchantId: api.merchantIds[0]!, sourceId: exportId, version: 'generation-1', createdAt: '2026-08-02T10:00:00.000Z', label: 'Private export file', digest: 'd'.repeat(64), status: 'ready' }];
  const user = userEvent.setup(); renderApp('/lifecycle');
  await screen.findByText(/1 source currently eligible · 1 kept as evidence/);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Source to hold or release' }), `export_file:${exportId}`);
  expect(screen.getByText(new RegExp(`Kept as evidence \\(linked to open case ${caseId}\\), so it is not eligible for deletion`))).toBeTruthy();
  expect(screen.getByRole('option', { name: new RegExp(`${exportId} · Evidence`) })).toBeTruthy();
});
