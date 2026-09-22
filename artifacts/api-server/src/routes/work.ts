import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { personalWorkQuerySchema, personalWorkViewSchema, workReceiptInputSchema, workReceiptSchema } from '@workspace/valopay-schema';
import { inWorkspace, loadState, caseAssignees } from '../lib/valopay-store';
import { withState } from './valopay';
import { derivePersonalWork, recordWorkReceipt } from '../domain/personal-work';

const router: IRouter = Router();
router.get('/v1/work', async (req, res) => {
  const query = personalWorkQuerySchema.parse(req.query);
  res.json(await inWorkspace(req, res, async ctx => {
    const state = await loadState(ctx, query.merchantId, 'share');
    return personalWorkViewSchema.parse(derivePersonalWork(state, ctx, await caseAssignees(ctx), query));
  }, 'read'));
});
for (const [path, action] of [['notifications/read', 'read'], ['handovers/acknowledge', 'acknowledge']] as const) {
  router.post(`/v1/work/${path}`, async (req, res) => {
    const input = workReceiptInputSchema.parse(req.body);
    z.string().min(8).max(200).parse(req.header('Idempotency-Key'));
    res.json(await withState(req, res, async (state, ctx) => recordWorkReceipt(state, ctx, await caseAssignees(ctx), action, input), true, workReceiptSchema));
  });
}
export default router;
