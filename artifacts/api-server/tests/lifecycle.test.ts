import assert from 'node:assert/strict';
import { retentionPolicySchema, lifecycleRunViewSchema, type LifecycleExternalCandidate } from '@workspace/valopay-schema';
import { seedMerchant } from '../src/lib/valopay-seed';
import { makeRecord } from '../src/domain/records';
import { lifecycleView, lifecyclePolicy, lifecycleHolds, lifecyclePreview, approveLifecycleRun, saveLifecyclePolicy, setLifecycleHold, assertLifecycleCandidate, eraseLifecycleRawCsv, recordLifecycleReceipt } from '../src/domain/lifecycle';
import type { DomainState } from '../src/domain/types';

const ctx = { actor: 'Clerk:admin', role: 'Admin', now: '2026-09-25T10:00:00.000Z' };
const policy = { rawCsvDays: 30, journalPayloadDays: 30, exportFileDays: 30, auditTrail: 'retain' as const };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const refuses = (fn: () => unknown, status: number) => { assert.throws(fn, (error: any) => error.status === status); checks += 1; };
function fixture(id = 'retention-test') {
  const state = seedMerchant(id, true);
  const batch = makeRecord(state, 'import-batches', { name: 'Imported source', status: 'committed', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', data: { csv: 'reference,name\nROW-1,Synthetic person', committedAt: '2026-08-01T10:00:00.000Z', rowIds: ['ROW-1'], recordIds: ['financial-1'], source: 'lms', sourceBatchId: 'feed-1', check: { valid: 1, invalid: 0, imported: 1, rows: [{ row: 1, status: 'valid', message: 'Imported' }], preview: [{ row: 1, values: { reference: 'ROW-1', name: 'Synthetic person' } }] } } });
  return { state, batch };
}
function enable(state: DomainState) { return saveLifecyclePolicy(state, ctx, { policy, expectedRevision: lifecyclePolicy(state).revision, reason: 'Agreed source retention for the synthetic rehearsal.' }); }
function preview(state: DomainState, external: LifecycleExternalCandidate[] = []) { return lifecyclePreview(state, ctx, { expectedPolicyRevision: lifecyclePolicy(state).revision }, external); }
function approve(state: DomainState, run: ReturnType<typeof preview>, external: LifecycleExternalCandidate[] = []) { return approveLifecycleRun(state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Reviewed the exact eligible sample source artifacts.' }, external); }
function hold(state: DomainState, sourceId: string, held: boolean) { return setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId, held, expectedHoldRevision: lifecycleHolds(state).revision, reason: held ? 'Keep this source for an unresolved sample case.' : 'The sample review is complete; release the source hold.' }); }
{
  const { state } = fixture();
  const view = lifecycleView(state, ctx);
  check(view.eligibleCount === 0 && view.policy.rawCsvDays === null && view.policy.journalPayloadDays === null && view.policy.exportFileDays === null, 'all deletion policies start disabled');
  check(view.auditRetained && view.financialRecordsRetained && view.policy.auditTrail === 'retain', 'audit and financial records are expressly retained');
  refuses(() => preview(state), 400);
  refuses(() => lifecycleView(state, { ...ctx, role: 'Operations' }), 403);
  refuses(() => saveLifecyclePolicy(state, { ...ctx, role: 'Read-only' }, { policy, expectedRevision: view.policyRevision, reason: 'An unauthorised policy edit.' }), 403);
  check(!retentionPolicySchema.safeParse({ ...policy, auditTrail: 'delete' }).success, 'there is no audit deletion policy');
  check(!retentionPolicySchema.safeParse({ ...policy, rawCsvDays: 0 }).success, 'zero-day immediate deletion cannot be configured');
  enable(state);
  refuses(() => saveLifecyclePolicy(state, ctx, { policy, expectedRevision: view.policyRevision, reason: 'The policy has already changed.' }), 409);
  check(lifecycleView(state, ctx).eligibleCount === 1 && state.records.some(record => record.kind === 'retention-policies'), 'an explicit versioned policy makes only aged terminal artifacts eligible');
}
{
  const { state, batch } = fixture('age'); enable(state);
  batch.data.committedAt = '2026-09-01T10:00:00.000Z';
  check(lifecycleView(state, ctx).eligibleCount === 0, 'raw retention age starts at commitment, not original batch creation');
  batch.status = 'ready'; batch.data.committedAt = '2026-08-01T10:00:00.000Z';
  check(lifecycleView(state, ctx).targets.length === 0, 'draft and correction-ready source CSV never enters retention inventory');
}
{
  const { state, batch } = fixture('holds'); enable(state);
  hold(state, batch.id, true);
  check(lifecycleView(state, ctx).eligibleCount === 0 && lifecycleView(state, ctx).holds.length === 1, 'per-source hold takes precedence over policy');
  refuses(() => preview(state), 400);
  hold(state, batch.id, false);
  const run = preview(state);
  const before = JSON.stringify(batch);
  check(run.status === 'preview' && JSON.stringify(batch) === before, 'preview persists identity but deletes nothing');
  hold(state, batch.id, true);
  refuses(() => approve(state, run), 409);
  check(typeof batch.data.csv === 'string', 'hold placed after preview prevents approval without deleting source');
  hold(state, batch.id, false);
  const fresh = approve(state, preview(state));
  hold(state, batch.id, true);
  refuses(() => assertLifecycleCandidate(state, ctx, fresh.id, fresh.candidates[0]!), 409);
  check(typeof batch.data.csv === 'string', 'hold placed after approval prevents execution');
  refuses(() => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: batch.id, held: false, expectedHoldRevision: 'a'.repeat(64), reason: 'Attempt a stale hold release.' }), 409);
  refuses(() => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: 'foreign-record', held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'Hold a source that does not belong here.' }), 404);
}
{
  const { state, batch } = fixture('freshness'); enable(state);
  const run = preview(state);
  refuses(() => approveLifecycleRun(state, { ...ctx, now: '2026-09-25T10:15:00.000Z' }, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'An expired preview must be refreshed.' }), 409);
  refuses(() => approveLifecycleRun(state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: 'b'.repeat(64), reason: 'A different manifest is not approved.' }), 409);
  refuses(() => approveLifecycleRun(state, { ...ctx, role: 'Finance' }, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Only the administrator can approve this.' }), 403);
  batch.data.csv += '\nROW-2,A changed source';
  refuses(() => approve(state, run), 409);
  check(typeof batch.data.csv === 'string', 'a changed raw source digest prevents old preview approval');
  const approved = approve(state, preview(state));
  saveLifecyclePolicy(state, ctx, { policy: { ...policy, rawCsvDays: 90 }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Extend raw source retention for this rehearsal.' });
  refuses(() => assertLifecycleCandidate(state, ctx, approved.id, approved.candidates[0]!), 409);
  check(typeof batch.data.csv === 'string', 'policy changes after approval block execution');
}
{
  const { state, batch } = fixture('delete'); enable(state);
  const protectedRecords = JSON.stringify(state.records.filter(record => !record.kind.startsWith('retention-') && record.id !== batch.id));
  const previewed = preview(state), candidate = previewed.candidates[0]!;
  refuses(() => eraseLifecycleRawCsv(state, ctx, previewed.id, candidate), 409);
  const approved = approve(state, previewed);
  check(approved.updatedAt > previewed.updatedAt && lifecycleRunViewSchema.safeParse(approved).success, 'approval response exposes the advanced source version before transactional validation');
  check(assertLifecycleCandidate(state, ctx, approved.id, candidate), 'approved unchanged unheld source passes the executor check');
  eraseLifecycleRawCsv(state, ctx, approved.id, candidate);
  const completed = recordLifecycleReceipt(state, ctx, approved.id, candidate, 'deleted', 'Committed source CSV and preview removed; imported records retained.');
  check(!('csv' in batch.data) && !('preview' in batch.data.check), 'only raw CSV and its raw preview were erased');
  check(batch.data.rowIds[0] === 'ROW-1' && batch.data.recordIds[0] === 'financial-1' && batch.status === 'committed', 'source-row provenance, financial links and batch commitment remain');
  check(JSON.stringify(state.records.filter(record => !record.kind.startsWith('retention-') && record.id !== batch.id)) === protectedRecords, 'underlying financial, case and audit records are unchanged');
  check(completed.status === 'completed' && completed.successful === 1 && completed.remaining === 0 && completed.receipts[0]!.status === 'deleted', 'verified deletion receipt completes exact run');
  check(assertLifecycleCandidate(state, ctx, approved.id, candidate) === false, 'successful receipts prevent repeated physical deletion');
  const repeat = recordLifecycleReceipt(state, ctx, approved.id, candidate, 'deleted', 'Repeated receipt');
  check(repeat.receipts.length === 1 && state.records.filter(record => record.kind === 'retention-receipts').length === 1, 'repeated completion does not invent duplicate receipts');
  check(lifecycleView(state, ctx).targets.length === 0, 'removed raw CSV is absent from future inventory');
}
{
  const { state } = fixture('external'); enable(state);
  const external: LifecycleExternalCandidate[] = [
    { kind: 'journal_payload', merchantId: state.merchant.id, sourceId: 'terminal-operation', version: 'v1', createdAt: '2026-08-01T00:00:00.000Z', label: 'Completed sample request', digest: 'a'.repeat(64), status: 'completed' },
    { kind: 'export_file', merchantId: state.merchant.id, sourceId: 'retained-file', version: 'generation-1', createdAt: '2026-08-02T00:00:00.000Z', label: 'Generated sample export', digest: 'b'.repeat(64), status: 'ready' },
    { kind: 'export_file', merchantId: 'different-lender', sourceId: 'foreign-export', version: 'generation-9', createdAt: '2026-08-02T00:00:00.000Z', label: 'Foreign export', digest: 'c'.repeat(64), status: 'ready' },
  ];
  const run = approve(state, preview(state, external), external);
  check(run.candidateCount === 3 && !JSON.stringify(run).includes('foreign-export'), 'external inventory is scoped to this lender');
  check(!JSON.stringify(run).includes('bucket') && !JSON.stringify(run).includes('objectName'), 'manifest exposes no internal storage locations');
  const file = run.candidates.find(candidate => candidate.kind === 'export_file')!;
  refuses(() => eraseLifecycleRawCsv(state, ctx, run.id, file), 400);
  const changed = external.map(candidate => candidate.sourceId === file.sourceId ? { ...candidate, version: 'generation-2' } : candidate);
  refuses(() => assertLifecycleCandidate(state, ctx, run.id, file, changed), 409);
  refuses(() => assertLifecycleCandidate(state, ctx, run.id, { ...file, sourceId: 'not-reviewed' }, external), 409);
  const failed = recordLifecycleReceipt(state, ctx, run.id, file, 'failed', 'Storage service did not confirm deletion.');
  check(failed.status === 'attention' && failed.successful === 0 && failed.remaining === 3, 'unconfirmed external deletion is never counted as success');
  check(assertLifecycleCandidate(state, ctx, run.id, file, external), 'failed candidate can resume after current identity and holds are checked');
  assert.throws(() => lifecycleView(state, ctx, [{ ...external[0]!, status: 'pending' } as any])); checks += 1;
  check(!state.records.some(record => record.kind === 'retention-receipts' && record.data.result === 'deleted'), 'pure domain never claims an external file or journal payload was deleted');
}
{
  const { state, batch } = fixture('bound'); enable(state);
  for (let i = 0; i < 104; i++) makeRecord(state, 'import-batches', { ...batch, id: `batch-${i}`, data: structuredClone(batch.data) });
  const run = preview(state);
  check(run.candidateCount === 100 && run.moreEligible === 5, 'each approved deletion manifest is bounded to100 exact artifacts');
  check(lifecycleView(state, ctx).targets.length === 100 && lifecycleView(state, ctx, [], 100).targets.length === 5, 'inventory has bounded pages');
  refuses(() => approveLifecycleRun(state, ctx, 'different-run', { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Not a run in this lender.' }), 404);
}
console.log(`Lifecycle retention: ${checks} checks passed.`);
