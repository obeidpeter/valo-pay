import { createHash } from 'node:crypto';
import { retentionPolicySchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecycleCandidateSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleRunViewSchema, lifecycleViewSchema, lifecycleReceiptStatusSchema, type LifecycleCandidate, type LifecycleExternalCandidate, type RetentionPolicy } from '@workspace/valopay-schema';
import type { Context, DomainState, ValopayRecord } from './types';
import { makeRecord, touch } from './records';

const DAY = 86400000;
const defaults: RetentionPolicy = { rawCsvDays: null, journalPayloadDays: null, exportFileDays: null, auditTrail: 'retain' };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function admin(ctx: Context) { if (ctx.role !== 'Admin') refuse('A currently authorised administrator is required for retention controls.', 403); }
const rows = (state: DomainState, kind: string) => state.records.filter(record => record.kind === kind && record.merchantId === state.merchant.id);
const ordered = (records: ValopayRecord[]) => [...records].sort((a, b) => Number(b.data.sequence || 0) - Number(a.data.sequence || 0) || b.createdAt.localeCompare(a.createdAt));
const nextSequence = (state: DomainState, kind: string) => Math.max(0, ...rows(state, kind).map(record => Number(record.data.sequence || 0))) + 1;
const candidateKey = (candidate: Pick<LifecycleCandidate, 'kind' | 'sourceId'>) => `${candidate.kind}:${candidate.sourceId}`;
function advanceRun(run: ValopayRecord, now: string) { touch(run, new Date(Math.max(Date.parse(now), Date.parse(run.updatedAt) + 1)).toISOString()); }
export function lifecyclePolicy(state: DomainState) {
  const latest = ordered(rows(state, 'retention-policies'))[0];
  const policy = retentionPolicySchema.parse(latest?.data.policy || defaults);
  return { policy, revision: hash({ merchantId: state.merchant.id, policy, recordId: latest?.id || null }) };
}
export function lifecycleHolds(state: DomainState) {
  const latest = new Map<string, ValopayRecord>();
  for (const record of ordered(rows(state, 'retention-holds'))) if (!latest.has(`${record.data.kind}:${record.data.sourceId}`)) latest.set(`${record.data.kind}:${record.data.sourceId}`, record);
  return { active: [...latest.values()].filter(record => record.data.held === true), revision: hash([...latest.values()].map(record => ({ id: record.id, data: record.data })).sort((a, b) => a.id.localeCompare(b.id))) };
}
function isHeld(state: DomainState, candidate: LifecycleCandidate) { return lifecycleHolds(state).active.some(record => record.data.kind === candidate.kind && record.data.sourceId === candidate.sourceId); }
function validateExternal(state: DomainState, candidates: LifecycleExternalCandidate[]): LifecycleCandidate[] {
  const result: LifecycleCandidate[] = [];
  for (const raw of candidates) {
    const candidate = lifecycleCandidateSchema.parse(raw);
    if (candidate.merchantId !== state.merchant.id) continue;
    if (candidate.kind === 'journal_payload' && !['completed', 'cancelled'].includes(candidate.status)) continue;
    if (candidate.kind === 'export_file' && !['ready', 'failed'].includes(candidate.status)) continue;
    if (!['journal_payload', 'export_file'].includes(candidate.kind)) continue;
    result.push(candidate);
  }
  if (new Set(result.map(candidateKey)).size !== result.length) refuse('The retention inventory contains duplicate source identities. Refresh before preparing a run.');
  return result;
}
export function lifecycleCandidates(state: DomainState, external: LifecycleExternalCandidate[] = []) {
  const raw: LifecycleCandidate[] = rows(state, 'import-batches').filter(record => record.status === 'committed' && typeof record.data.csv === 'string' && record.data.csv.length > 0 && typeof record.data.committedAt === 'string').map(record => lifecycleCandidateSchema.parse({ kind: 'raw_csv', merchantId: state.merchant.id, sourceId: record.id, version: record.updatedAt, createdAt: record.data.committedAt, label: 'Committed import source CSV', digest: hash({ id: record.id, version: record.updatedAt, csv: record.data.csv, preview: record.data.check?.preview || null }), status: 'committed' }));
  return [...raw, ...validateExternal(state, external)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || candidateKey(a).localeCompare(candidateKey(b)));
}
function eligible(state: DomainState, ctx: Context, candidate: LifecycleCandidate) {
  const policy = lifecyclePolicy(state).policy;
  const days = candidate.kind === 'raw_csv' ? policy.rawCsvDays : candidate.kind === 'journal_payload' ? policy.journalPayloadDays : policy.exportFileDays;
  return days !== null && Date.parse(candidate.createdAt) + days * DAY <= Date.parse(ctx.now) && !isHeld(state, candidate);
}
function runOf(state: DomainState, id: string) { return rows(state, 'retention-runs').find(record => record.id === id) || refuse('Retention run not found in this lender.', 404); }
function latestReceipts(state: DomainState, runId: string) {
  const result = new Map<string, ValopayRecord>();
  for (const receipt of ordered(rows(state, 'retention-receipts').filter(record => record.data.runId === runId))) if (!result.has(`${receipt.data.kind}:${receipt.data.sourceId}`)) result.set(`${receipt.data.kind}:${receipt.data.sourceId}`, receipt);
  return result;
}
export function lifecycleRunView(state: DomainState, run: ValopayRecord) {
  const receipts = [...latestReceipts(state, run.id).values()];
  const successful = receipts.filter(receipt => ['deleted', 'already_absent'].includes(receipt.data.result)).length;
  return lifecycleRunViewSchema.parse({ id: run.id, merchantId: state.merchant.id, status: run.status, updatedAt: run.updatedAt, createdAt: run.createdAt, expiresAt: run.data.expiresAt, previewDigest: run.data.previewDigest, policyRevision: run.data.policyRevision, candidates: run.data.candidates, candidateCount: run.data.candidates.length, moreEligible: run.data.moreEligible || 0, approvedBy: run.data.approvedBy || null, approvedAt: run.data.approvedAt || null, receipts: receipts.map(receipt => ({ id: receipt.id, kind: receipt.data.kind, sourceId: receipt.data.sourceId, status: receipt.data.result, at: receipt.createdAt, detail: receipt.data.detail, actor: receipt.data.actor })), successful, remaining: run.data.candidates.length - successful, auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
}
export function lifecycleView(state: DomainState, ctx: Context, external: LifecycleExternalCandidate[] = [], targetOffset = 0) {
  admin(ctx);
  if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset > 100000) refuse('Choose a valid retention inventory page.', 400);
  const { policy, revision } = lifecyclePolicy(state), holds = lifecycleHolds(state), candidates = lifecycleCandidates(state, external);
  return lifecycleViewSchema.parse({ merchantId: state.merchant.id, lenderName: state.merchant.name, actor: ctx.actor, asOf: ctx.now, policy, policyRevision: revision, holdRevision: holds.revision, eligibleCount: candidates.filter(candidate => eligible(state, ctx, candidate)).length, targets: candidates.slice(targetOffset, targetOffset + 100).map(candidate => ({ ...candidate, held: isHeld(state, candidate) })), targetTotal: candidates.length, targetOffset, holds: holds.active.slice(0, 100).map(record => ({ kind: record.data.kind, sourceId: record.data.sourceId, reason: record.data.reason, actor: record.data.actor, at: record.createdAt })), holdTotal: holds.active.length, runs: rows(state, 'retention-runs').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 10).map(run => lifecycleRunView(state, run)), auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
}
export function saveLifecyclePolicy(state: DomainState, ctx: Context, raw: unknown) {
  admin(ctx); const input = retentionPolicyInputSchema.parse(raw);
  if (input.expectedRevision !== lifecyclePolicy(state).revision) refuse('The retention policy changed. Refresh and review the current policy.');
  makeRecord(state, 'retention-policies', { name: 'Retention policy saved', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { policy: input.policy, actor: ctx.actor, reason: input.reason, sequence: nextSequence(state, 'retention-policies'), synthetic: true } });
  return lifecyclePolicy(state);
}
export function setLifecycleHold(state: DomainState, ctx: Context, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = retentionHoldInputSchema.parse(raw), holds = lifecycleHolds(state);
  if (holds.revision !== input.expectedHoldRevision) refuse('Retention holds changed. Refresh before changing this hold.');
  const existing = holds.active.find(record => record.data.kind === input.kind && record.data.sourceId === input.sourceId);
  if (!lifecycleCandidates(state, external).some(candidate => candidate.kind === input.kind && candidate.sourceId === input.sourceId) && !existing) refuse('This retained source was not found in the selected lender.', 404);
  if (Boolean(existing) === input.held) return holds;
  makeRecord(state, 'retention-holds', { name: input.held ? 'Retention hold placed' : 'Retention hold released', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { ...input, actor: ctx.actor, sequence: nextSequence(state, 'retention-holds'), synthetic: true } });
  return lifecycleHolds(state);
}
export function lifecyclePreview(state: DomainState, ctx: Context, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = lifecyclePreviewInputSchema.parse(raw), policy = lifecyclePolicy(state);
  if (input.expectedPolicyRevision !== policy.revision) refuse('The retention policy changed. Refresh before preparing a deletion preview.');
  const all = lifecycleCandidates(state, external).filter(candidate => eligible(state, ctx, candidate));
  if (!all.length) refuse('No retained sources currently meet the enabled policy and hold rules.', 400);
  const candidates = all.slice(0, 100), previewDigest = hash({ merchantId: state.merchant.id, policyRevision: policy.revision, candidates });
  const run = makeRecord(state, 'retention-runs', { name: 'Retention deletion preview', status: 'preview', createdAt: ctx.now, updatedAt: ctx.now, data: { candidates, previewDigest, policyRevision: policy.revision, moreEligible: all.length - candidates.length, expiresAt: new Date(Date.parse(ctx.now) + 15 * 60 * 1000).toISOString(), preparedBy: ctx.actor, synthetic: true } });
  return lifecycleRunView(state, run);
}
export function approveLifecycleRun(state: DomainState, ctx: Context, id: string, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = lifecycleApproveInputSchema.parse(raw), run = runOf(state, id);
  if (run.status !== 'preview' || input.expectedUpdatedAt !== run.updatedAt || input.previewDigest !== run.data.previewDigest) refuse('This preview changed or has already been approved. Refresh its saved status.');
  if (Date.parse(ctx.now) >= Date.parse(run.data.expiresAt)) refuse('This preview expired. Prepare a new preview and review its current sources.');
  if (lifecyclePolicy(state).revision !== run.data.policyRevision) refuse('The retention policy changed. Prepare a new preview.');
  const current = lifecycleCandidates(state, external);
  for (const candidate of run.data.candidates as LifecycleCandidate[]) {
    const found = current.find(item => candidateKey(item) === candidateKey(candidate));
    if (!found || canonical(found) !== canonical(candidate) || !eligible(state, ctx, found)) refuse('A previewed source changed, is held or is no longer eligible. Prepare a new preview.');
  }
  run.status = 'approved'; Object.assign(run.data, { approvedBy: ctx.actor, approvedAt: ctx.now, approvalReason: input.reason }); advanceRun(run, ctx.now);
  return lifecycleRunView(state, run);
}
/** Store worker calls this immediately before each irreversible operation while holding the lender lock. */
export function assertLifecycleCandidate(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const run = runOf(state, runId);
  if (!['approved', 'running', 'attention', 'completed'].includes(run.status) || !run.data.approvedBy) refuse('Approve the exact retention preview before executing it.');
  if (!run.data.candidates.some((saved: LifecycleCandidate) => canonical(saved) === canonical(candidate))) refuse('This source was not part of the approved preview.');
  if (latestReceipts(state, runId).get(candidateKey(candidate))?.data.result === 'deleted' || latestReceipts(state, runId).get(candidateKey(candidate))?.data.result === 'already_absent') return false;
  if (lifecyclePolicy(state).revision !== run.data.policyRevision) refuse('Retention policy changed after approval. Prepare a new preview before deleting anything else.');
  const current = lifecycleCandidates(state, external).find(item => candidateKey(item) === candidateKey(candidate));
  if (!current || canonical(current) !== canonical(candidate) || !eligible(state, ctx, current)) refuse('This source changed, is held or is no longer eligible. Nothing was deleted by this check.');
  return true;
}
/** Raw CSV is the only artifact erased in this pure domain service. Imported records, identity provenance and audit are retained. */
export function eraseLifecycleRawCsv(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate) {
  if (candidate.kind !== 'raw_csv') refuse('External artifacts must be deleted by the storage service.', 400);
  if (!assertLifecycleCandidate(state, ctx, runId, candidate)) return;
  const batch = rows(state, 'import-batches').find(record => record.id === candidate.sourceId)!;
  delete batch.data.csv;
  if (batch.data.check) delete batch.data.check.preview;
  batch.data.rawCsvRemovedAt = ctx.now;
  batch.data.rawCsvRetentionRunId = runId;
  touch(batch, ctx.now);
}
/** Only a verified executor outcome may be recorded; the UI cannot submit deletion receipts. */
export function recordLifecycleReceipt(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, result: 'deleted' | 'already_absent' | 'blocked' | 'failed', detail: string) {
  admin(ctx); lifecycleReceiptStatusSchema.parse(result); const run = runOf(state, runId);
  if (!run.data.approvedBy || !['approved', 'running', 'attention', 'completed'].includes(run.status)) refuse('This deletion run is not approved.');
  if (!run.data.candidates.some((saved: LifecycleCandidate) => canonical(saved) === canonical(candidate))) refuse('The receipt does not match the approved source identity.');
  const prior = latestReceipts(state, runId).get(candidateKey(candidate));
  if (prior && ['deleted', 'already_absent'].includes(prior.data.result)) return lifecycleRunView(state, run);
  makeRecord(state, 'retention-receipts', { name: 'Retention execution receipt', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { runId, kind: candidate.kind, sourceId: candidate.sourceId, sourceDigest: candidate.digest, version: candidate.version, result, detail: detail.slice(0, 500), actor: ctx.actor, sequence: nextSequence(state, 'retention-receipts'), synthetic: true } });
  const receipts = [...latestReceipts(state, runId).values()];
  run.status = receipts.filter(record => ['deleted', 'already_absent'].includes(record.data.result)).length === run.data.candidates.length ? 'completed' : receipts.some(record => ['blocked', 'failed'].includes(record.data.result)) ? 'attention' : 'running';
  advanceRun(run, ctx.now); return lifecycleRunView(state, run);
}
