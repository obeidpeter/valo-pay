import { createHash } from 'node:crypto';
import { retentionPolicySchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecycleCandidateSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleRunViewSchema, lifecycleViewSchema, lifecycleReceiptStatusSchema, type LifecycleCandidate, type LifecycleEvidence, type LifecycleExternalCandidate, type RetentionPolicy } from '@workspace/valopay-schema';
import type { Context, DomainState, ValopayRecord } from './types';
import { makeRecord, touch, assertSourceOpened } from './records';

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
const settled = (receipt: ValopayRecord | undefined) => receipt?.data.result === 'deleted' || receipt?.data.result === 'already_absent';
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
/**
 * The export files this lender still relies on as evidence, whatever the
 * retention policy says, by export ID: a file linked to a case that is still
 * open, and the reviewed-close export of an approved Finance review (an
 * approval is final, so that export stays evidence). Such a file is never
 * eligible for deletion, so it needs no hold, and the view says why. A case
 * that is resolved or closed no longer keeps its evidence.
 */
function lifecycleEvidence(state: DomainState): Map<string, LifecycleEvidence[]> {
  const evidence = new Map<string, LifecycleEvidence[]>(), approved = new Set(rows(state, 'close-reviews').filter(review => review.status === 'approved').map(review => review.id));
  const add = (exportId: string, reason: LifecycleEvidence) => { const reasons = evidence.get(exportId) ?? []; if (reasons.length < 10) reasons.push(reason); evidence.set(exportId, reasons); };
  for (const record of state.records) {
    if (record.merchantId !== state.merchant.id) continue;
    if (record.kind === 'exceptions' && !['resolved', 'closed'].includes(record.status) && Array.isArray(record.data.case?.evidenceIds)) {
      for (const id of new Set<unknown>(record.data.case.evidenceIds)) if (typeof id === 'string' && id) add(id, { reason: 'open_case', recordId: record.id });
    } else if (record.kind === 'exports' && typeof record.data.closeReviewId === 'string' && approved.has(record.data.closeReviewId)) add(record.id, { reason: 'approved_close_review', recordId: record.data.closeReviewId });
  }
  return evidence;
}
/**
 * What every source is checked against, read from the lender once: the
 * current policy, the sources an active hold protects and the files kept as
 * evidence. Checking a source is then a lookup, so a request's cost grows with
 * its records plus its sources, never with the two multiplied. Read it again
 * after the state changes.
 */
function rulesOf(state: DomainState, ctx: Context, policy = lifecyclePolicy(state).policy, holds = lifecycleHolds(state)) {
  return { policy, held: new Set(holds.active.map(record => `${record.data.kind}:${record.data.sourceId}`)), evidence: lifecycleEvidence(state), now: Date.parse(ctx.now) };
}
type Rules = ReturnType<typeof rulesOf>;
const evidenceFor = (rules: Rules, candidate: LifecycleCandidate): LifecycleEvidence[] => candidate.kind === 'export_file' ? rules.evidence.get(candidate.sourceId) ?? [] : [];
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
  const batches = rows(state, 'import-batches');
  // A committed batch whose rows were not opened would silently drop out of the inventory.
  for (const record of batches) if (record.status === 'committed' && record.data.csv !== undefined) assertSourceOpened(record, ['csv', 'check']);
  const raw: LifecycleCandidate[] = batches.filter(record => record.status === 'committed' && typeof record.data.csv === 'string' && record.data.csv.length > 0 && typeof record.data.committedAt === 'string').map(record => lifecycleCandidateSchema.parse({ kind: 'raw_csv', merchantId: state.merchant.id, sourceId: record.id, version: record.updatedAt, createdAt: record.data.committedAt, label: 'Committed import source CSV', digest: hash({ id: record.id, version: record.updatedAt, csv: record.data.csv, preview: record.data.check?.preview || null }), status: 'committed' }));
  return [...raw, ...validateExternal(state, external)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || candidateKey(a).localeCompare(candidateKey(b)));
}
function eligible(rules: Rules, candidate: LifecycleCandidate) {
  const days = candidate.kind === 'raw_csv' ? rules.policy.rawCsvDays : candidate.kind === 'journal_payload' ? rules.policy.journalPayloadDays : rules.policy.exportFileDays;
  return days !== null && Date.parse(candidate.createdAt) + days * DAY <= rules.now && !rules.held.has(candidateKey(candidate)) && !evidenceFor(rules, candidate).length;
}
function runOf(state: DomainState, id: string) { return rows(state, 'retention-runs').find(record => record.id === id) || refuse('Retention run not found in this lender.', 404); }
/** The latest receipt for each source of each run, from one pass over the lender's receipts. */
function receiptsByRun(state: DomainState) {
  const result = new Map<string, Map<string, ValopayRecord>>();
  for (const receipt of ordered(rows(state, 'retention-receipts'))) {
    const run = result.get(receipt.data.runId) ?? new Map<string, ValopayRecord>();
    result.set(receipt.data.runId, run);
    if (!run.has(`${receipt.data.kind}:${receipt.data.sourceId}`)) run.set(`${receipt.data.kind}:${receipt.data.sourceId}`, receipt);
  }
  return result;
}
const latestReceipts = (state: DomainState, runId: string) => receiptsByRun(state).get(runId) ?? new Map<string, ValopayRecord>();
function runView(state: DomainState, run: ValopayRecord, latest: Map<string, ValopayRecord>) {
  const receipts = [...latest.values()];
  const successful = receipts.filter(receipt => ['deleted', 'already_absent'].includes(receipt.data.result)).length;
  return lifecycleRunViewSchema.parse({ id: run.id, merchantId: state.merchant.id, status: run.status, updatedAt: run.updatedAt, createdAt: run.createdAt, expiresAt: run.data.expiresAt, previewDigest: run.data.previewDigest, policyRevision: run.data.policyRevision, candidates: run.data.candidates, candidateCount: run.data.candidates.length, moreEligible: run.data.moreEligible || 0, approvedBy: run.data.approvedBy || null, approvedAt: run.data.approvedAt || null, receipts: receipts.map(receipt => ({ id: receipt.id, kind: receipt.data.kind, sourceId: receipt.data.sourceId, status: receipt.data.result, at: receipt.createdAt, detail: receipt.data.detail, actor: receipt.data.actor })), successful, remaining: run.data.candidates.length - successful, auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
}
export function lifecycleRunView(state: DomainState, run: ValopayRecord) { return runView(state, run, latestReceipts(state, run.id)); }
export function lifecycleView(state: DomainState, ctx: Context, external: LifecycleExternalCandidate[] = [], targetOffset = 0) {
  admin(ctx);
  if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset > 100000) refuse('Choose a valid retention inventory page.', 400);
  const { policy, revision } = lifecyclePolicy(state), holds = lifecycleHolds(state), candidates = lifecycleCandidates(state, external), rules = rulesOf(state, ctx, policy, holds), receipts = receiptsByRun(state);
  return lifecycleViewSchema.parse({ merchantId: state.merchant.id, lenderName: state.merchant.name, actor: ctx.actor, asOf: ctx.now, policy, policyRevision: revision, holdRevision: holds.revision, eligibleCount: candidates.filter(candidate => eligible(rules, candidate)).length, evidenceTotal: candidates.filter(candidate => evidenceFor(rules, candidate).length).length, targets: candidates.slice(targetOffset, targetOffset + 100).map(candidate => ({ ...candidate, held: rules.held.has(candidateKey(candidate)), evidence: evidenceFor(rules, candidate) })), targetTotal: candidates.length, targetOffset, holds: holds.active.slice(0, 100).map(record => ({ kind: record.data.kind, sourceId: record.data.sourceId, reason: record.data.reason, actor: record.data.actor, at: record.createdAt })), holdTotal: holds.active.length, runs: rows(state, 'retention-runs').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 10).map(run => runView(state, run, receipts.get(run.id) ?? new Map())), auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
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
  const rules = rulesOf(state, ctx, policy.policy), all = lifecycleCandidates(state, external).filter(candidate => eligible(rules, candidate));
  if (!all.length) refuse('No retained sources currently meet the enabled policy and hold rules.', 400);
  const candidates = all.slice(0, 100), previewDigest = hash({ merchantId: state.merchant.id, policyRevision: policy.revision, candidates });
  const run = makeRecord(state, 'retention-runs', { name: 'Retention deletion preview', status: 'preview', createdAt: ctx.now, updatedAt: ctx.now, data: { candidates, previewDigest, policyRevision: policy.revision, moreEligible: all.length - candidates.length, expiresAt: new Date(Date.parse(ctx.now) + 15 * 60 * 1000).toISOString(), preparedBy: ctx.actor, synthetic: true } });
  return lifecycleRunView(state, run);
}
export function approveLifecycleRun(state: DomainState, ctx: Context, id: string, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = lifecycleApproveInputSchema.parse(raw), run = runOf(state, id);
  if (run.status !== 'preview' || input.expectedUpdatedAt !== run.updatedAt || input.previewDigest !== run.data.previewDigest) refuse('This preview changed or has already been approved. Refresh its saved status.');
  if (Date.parse(ctx.now) >= Date.parse(run.data.expiresAt)) refuse('This preview expired. Prepare a new preview and review its current sources.');
  const policy = lifecyclePolicy(state);
  if (policy.revision !== run.data.policyRevision) refuse('The retention policy changed. Prepare a new preview.');
  const current = new Map(lifecycleCandidates(state, external).map(item => [candidateKey(item), item])), rules = rulesOf(state, ctx, policy.policy);
  for (const candidate of run.data.candidates as LifecycleCandidate[]) {
    const found = current.get(candidateKey(candidate));
    if (!found || canonical(found) !== canonical(candidate) || !eligible(rules, found)) refuse('A previewed source changed, is held or is no longer eligible. Prepare a new preview.');
  }
  run.status = 'approved'; Object.assign(run.data, { approvedBy: ctx.actor, approvedAt: ctx.now, approvalReason: input.reason }); advanceRun(run, ctx.now);
  return lifecycleRunView(state, run);
}
/**
 * The check the store's worker makes, while holding the lender lock,
 * immediately before each irreversible operation of one approved run. What it
 * compares (the run's receipts, the current policy, sources, holds and
 * evidence) is read from the lender once, when first needed, so checking every
 * source of a run costs a lookup each. The check answers false for a source
 * the run already removed, true for one that may be removed now, and refuses
 * anything else. Prepare it again after the state changes.
 */
export function lifecycleCandidateCheck(state: DomainState, ctx: Context, runId: string, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const run = runOf(state, runId), latest = latestReceipts(state, runId), manifest = new Set((run.data.candidates as LifecycleCandidate[]).map(saved => canonical(saved)));
  let revision: string | undefined, current: Map<string, LifecycleCandidate> | undefined, rules: Rules | undefined;
  return (candidate: LifecycleCandidate): boolean => {
    if (!['approved', 'running', 'attention', 'completed'].includes(run.status) || !run.data.approvedBy) refuse('Approve the exact retention preview before executing it.');
    if (!manifest.has(canonical(candidate))) refuse('This source was not part of the approved preview.');
    if (settled(latest.get(candidateKey(candidate)))) return false;
    revision ??= lifecyclePolicy(state).revision;
    if (revision !== run.data.policyRevision) refuse('Retention policy changed after approval. Prepare a new preview before deleting anything else.');
    current ??= new Map(lifecycleCandidates(state, external).map(item => [candidateKey(item), item]));
    rules ??= rulesOf(state, ctx);
    const found = current.get(candidateKey(candidate));
    if (!found || canonical(found) !== canonical(candidate) || !eligible(rules, found)) refuse('This source changed, is held or is no longer eligible. Nothing was deleted by this check.');
    return true;
  };
}
/** Store worker calls this immediately before each irreversible operation while holding the lender lock. */
export function assertLifecycleCandidate(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, external: LifecycleExternalCandidate[] = []) {
  return lifecycleCandidateCheck(state, ctx, runId, external)(candidate);
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
