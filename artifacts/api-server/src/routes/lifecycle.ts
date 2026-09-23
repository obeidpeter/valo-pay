import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { lifecycleViewSchema, lifecycleRunViewSchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleExecuteInputSchema } from '@workspace/valopay-schema';
import { contractAnswer, lenderPage, lenderQuery, requiredKey } from '../lib/contract';
import { inWorkspace, loadState, lifecycleInventory, executeLifecycleRun, revealImportPayloads, fail, type StoreContext } from '../lib/valopay-store';
import { withState } from './valopay';
import { lifecycleView, lifecycleRunView, saveLifecyclePolicy, setLifecycleHold, lifecyclePreview, approveLifecycleRun } from '../domain/lifecycle';
import type { DomainState } from '../domain/types';

const router: IRouter = Router();
const idOf = (id: unknown) => z.string().min(1).max(100).parse(id);
/** The raw-CSV inventory digests each committed batch's source rows, so an administrator's retention screens open them first; before the domain changes anything in a write. */
const openRawSources = (ctx: StoreContext, state: DomainState) => ctx.role === 'Admin' ? revealImportPayloads(ctx, state, record => record.status === 'committed' && record.data.csv !== undefined) : Promise.resolve(0);
router.get('/v1/lifecycle', async (req, res) => {
  const input = lenderPage(req);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail('An administrator is required to view retention controls.', 403); const state = await loadState(ctx, input.merchantId, 'share'); await openRawSources(ctx, state); return contractAnswer(lifecycleViewSchema, lifecycleView(state, ctx, await lifecycleInventory(ctx, state), input.offset)); }, 'read'));
});
router.get('/v1/lifecycle/runs/:id', async (req, res) => {
  const input = lenderQuery(req), id = idOf(req.params.id);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail('An administrator is required to view retention controls.', 403); const state = await loadState(ctx, input.merchantId, 'share'), run = state.records.find(record => record.merchantId === state.merchant.id && record.kind === 'retention-runs' && record.id === id); if (!run) fail('Retention run not found in this lender.', 404); return contractAnswer(lifecycleRunViewSchema, lifecycleRunView(state, run)); }, 'read'));
});
router.post('/v1/lifecycle/policy', async (req, res) => {
  requiredKey(req); const input = retentionPolicyInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); saveLifecyclePolicy(state, ctx, input); return lifecycleView(state, ctx, await lifecycleInventory(ctx, state)); }, true, lifecycleViewSchema));
});
router.post('/v1/lifecycle/holds', async (req, res) => {
  requiredKey(req); const input = retentionHoldInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); const inventory = await lifecycleInventory(ctx, state); setLifecycleHold(state, ctx, input, inventory); return lifecycleView(state, ctx, inventory); }, true, lifecycleViewSchema));
});
router.post('/v1/lifecycle/runs', async (req, res) => {
  requiredKey(req); const input = lifecyclePreviewInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); return lifecyclePreview(state, ctx, input, await lifecycleInventory(ctx, state)); }, true, lifecycleRunViewSchema));
});
router.post('/v1/lifecycle/runs/:id/approve', async (req, res) => {
  requiredKey(req); const input = lifecycleApproveInputSchema.parse(req.body), id = idOf(req.params.id);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); return approveLifecycleRun(state, ctx, id, input, await lifecycleInventory(ctx, state)); }, true, lifecycleRunViewSchema));
});
router.post('/v1/lifecycle/runs/:id/execute', async (req, res) => {
  requiredKey(req); const input = lifecycleExecuteInputSchema.parse(req.body), id = idOf(req.params.id);
  res.json(await withState(req, res, async (state, ctx) => { if (ctx.role !== 'Admin') fail('An administrator is required to execute retention controls.', 403); await openRawSources(ctx, state); const run = state.records.find(record => record.kind === 'retention-runs' && record.id === id && record.merchantId === state.merchant.id); if (!run || run.data.previewDigest !== input.previewDigest) fail('The approved preview does not match this request. Refresh its saved status.', 409); return executeLifecycleRun(ctx, state, id); }, true, lifecycleRunViewSchema));
});
export default router;
