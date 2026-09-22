import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { lifecycleViewSchema, lifecycleRunViewSchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleExecuteInputSchema } from '@workspace/valopay-schema';
import { inWorkspace, loadState, lifecycleInventory, executeLifecycleRun, fail } from '../lib/valopay-store';
import { withState } from './valopay';
import { lifecycleView, lifecycleRunView, saveLifecyclePolicy, setLifecycleHold, lifecyclePreview, approveLifecycleRun } from '../domain/lifecycle';

const router: IRouter = Router();
const query = z.object({ merchantId: z.string().min(1).max(100), offset: z.coerce.number().int().min(0).max(100000).default(0) });
const idOf = (id: unknown) => z.string().min(1).max(100).parse(id);
const key = (value: unknown) => z.string().min(8).max(200).parse(value);
router.get('/v1/lifecycle', async (req, res) => {
  const input = query.parse(req.query);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail('An administrator is required to view retention controls.', 403); const state = await loadState(ctx, input.merchantId, 'share'); return lifecycleView(state, ctx, await lifecycleInventory(ctx, state), input.offset); }, 'read'));
});
router.get('/v1/lifecycle/runs/:id', async (req, res) => {
  const input = query.parse(req.query), id = idOf(req.params.id);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail('An administrator is required to view retention controls.', 403); const state = await loadState(ctx, input.merchantId, 'share'), run = state.records.find(record => record.merchantId === state.merchant.id && record.kind === 'retention-runs' && record.id === id); if (!run) fail('Retention run not found in this lender.', 404); return lifecycleRunView(state, run); }, 'read'));
});
router.post('/v1/lifecycle/policy', async (req, res) => {
  const input = retentionPolicyInputSchema.parse(req.body); key(req.header('Idempotency-Key'));
  res.json(await withState(req, res, async (state, ctx) => { saveLifecyclePolicy(state, ctx, input); return lifecycleView(state, ctx, await lifecycleInventory(ctx, state)); }, true, lifecycleViewSchema));
});
router.post('/v1/lifecycle/holds', async (req, res) => {
  const input = retentionHoldInputSchema.parse(req.body); key(req.header('Idempotency-Key'));
  res.json(await withState(req, res, async (state, ctx) => { const inventory = await lifecycleInventory(ctx, state); setLifecycleHold(state, ctx, input, inventory); return lifecycleView(state, ctx, inventory); }, true, lifecycleViewSchema));
});
router.post('/v1/lifecycle/runs', async (req, res) => {
  const input = lifecyclePreviewInputSchema.parse(req.body); key(req.header('Idempotency-Key'));
  res.json(await withState(req, res, async (state, ctx) => lifecyclePreview(state, ctx, input, await lifecycleInventory(ctx, state)), true, lifecycleRunViewSchema));
});
router.post('/v1/lifecycle/runs/:id/approve', async (req, res) => {
  const input = lifecycleApproveInputSchema.parse(req.body), id = idOf(req.params.id); key(req.header('Idempotency-Key'));
  res.json(await withState(req, res, async (state, ctx) => approveLifecycleRun(state, ctx, id, input, await lifecycleInventory(ctx, state)), true, lifecycleRunViewSchema));
});
router.post('/v1/lifecycle/runs/:id/execute', async (req, res) => {
  const input = lifecycleExecuteInputSchema.parse(req.body), id = idOf(req.params.id); key(req.header('Idempotency-Key'));
  res.json(await withState(req, res, async (state, ctx) => { if (ctx.role !== 'Admin') fail('An administrator is required to execute retention controls.', 403); const run = state.records.find(record => record.kind === 'retention-runs' && record.id === id && record.merchantId === state.merchant.id); if (!run || run.data.previewDigest !== input.previewDigest) fail('The approved preview does not match this request. Refresh its saved status.', 409); return executeLifecycleRun(ctx, state, id); }, true, lifecycleRunViewSchema));
});
export default router;
