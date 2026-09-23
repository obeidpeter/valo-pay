import { Router, type IRouter, type RequestHandler } from 'express';
import { z } from 'zod';
import { personalWorkQuerySchema, personalWorkViewSchema, workReceiptInputSchema, workReceiptSchema } from '@workspace/valopay-schema';
import { inWorkspace, loadState, caseAssignees } from '../lib/valopay-store';
import { withState } from './valopay';
import { contractAnswer, lenderQuery, requiredKey } from '../lib/contract';
import { derivePersonalWork, recordWorkReceipt } from '../domain/personal-work';

const router: IRouter = Router();
router.get('/v1/work', async (req, res) => {
  lenderQuery(req);
  const query = personalWorkQuerySchema.parse(req.query);
  res.json(await inWorkspace(req, res, async ctx => {
    const state = await loadState(ctx, query.merchantId, 'share');
    return contractAnswer(personalWorkViewSchema, derivePersonalWork(state, ctx, await caseAssignees(ctx), query));
  }, 'read'));
});
// Each receipt route is registered with its literal path, so the contract check can read it.
const receipt = (action: 'read' | 'acknowledge'): RequestHandler => async (req, res) => {
  requiredKey(req);
  const input = workReceiptInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => recordWorkReceipt(state, ctx, await caseAssignees(ctx), action, input), true, workReceiptSchema));
};
router.post('/v1/work/notifications/read', receipt('read'));
router.post('/v1/work/handovers/acknowledge', receipt('acknowledge'));
export default router;
