import type { LifecycleCandidate, LifecycleExternalCandidate } from '@workspace/valopay-schema';
import type { Context, DomainState } from './types';
import { eraseLifecycleRawCsv, lifecycleCandidateCheck, lifecycleRunView, recordLifecycleReceipt } from './lifecycle';

/**
 * How long one execute request keeps starting sources. The request holds the
 * lender's lock throughout, and other requests wait at most 5 s for it, so a
 * run of many sources is removed over several requests instead of one long one.
 */
export const LIFECYCLE_STEP_BUDGET_MS = 2_000;
/** Removes one approved source kept outside the lender's records (a completed request's payload or an export file). */
export type LifecycleRemoval = (candidate: LifecycleCandidate) => Promise<'deleted' | 'already_absent'>;
export interface LifecycleStepOptions {
  /** Starts no further source once this many milliseconds have passed; the first source always runs. */
  budgetMs?: number;
  /** An error that must end the request instead of becoming a failed receipt, such as a database error that aborts the transaction. */
  fatal?: (error: unknown) => boolean;
  /** The clock the budget is measured on, in milliseconds. */
  clock?: () => number;
}
const key = (candidate: Pick<LifecycleCandidate, 'kind' | 'sourceId'>) => `${candidate.kind}:${candidate.sourceId}`;

/**
 * Executes an approved retention run: source after source, each checked again
 * just before it is removed and given its own receipt, until the run
 * completes, a source is blocked or its deletion cannot be confirmed (either
 * stops the run, and its receipt says why), or the time budget is spent. The
 * caller asks again to continue. Sources not yet attempted go first, so a
 * blocked or failed source is tried again only after the rest.
 */
export async function executeApprovedRun(state: DomainState, ctx: Context, runId: string, external: LifecycleExternalCandidate[], remove: LifecycleRemoval, options: LifecycleStepOptions = {}) {
  const { budgetMs = LIFECYCLE_STEP_BUDGET_MS, fatal = () => false, clock = () => performance.now() } = options;
  const run = state.records.find(record => record.kind === 'retention-runs' && record.id === runId && record.merchantId === state.merchant.id);
  if (!run) throw Object.assign(new Error('Retention run not found in this lender.'), { status: 404 });
  if (run.status === 'completed') return lifecycleRunView(state, run);
  const attempted = new Set(state.records.filter(record => record.kind === 'retention-receipts' && record.data.runId === runId).map(record => `${record.data.kind}:${record.data.sourceId}`));
  const candidates = [...run.data.candidates as LifecycleCandidate[]].sort((a, b) => Number(attempted.has(key(a))) - Number(attempted.has(key(b))));
  // Prepared once for the request: removing one source changes no other source, nor the policy, holds or evidence the check compares.
  const check = lifecycleCandidateCheck(state, ctx, runId, external), started = clock();
  for (const candidate of candidates) {
    try {
      if (!check(candidate)) continue;
    } catch {
      recordLifecycleReceipt(state, ctx, runId, candidate, 'blocked', 'This source changed, is held or no longer meets the approved policy. Review the source and prepare a fresh preview.');
      break;
    }
    let result: 'deleted' | 'already_absent' = 'deleted';
    try {
      if (candidate.kind === 'raw_csv') eraseLifecycleRawCsv(state, ctx, runId, candidate, check);
      else result = await remove(candidate);
    } catch (error) {
      if (fatal(error)) throw error;
      recordLifecycleReceipt(state, ctx, runId, candidate, 'failed', 'Deletion could not be confirmed. Resume this saved run to check the same source; do not create a replacement export.');
      break;
    }
    recordLifecycleReceipt(state, ctx, runId, candidate, result, 'Retention action completed. Financial records, provenance, request identities and audit history were retained.');
    if (clock() - started >= budgetMs) break;
  }
  return lifecycleRunView(state, run);
}
