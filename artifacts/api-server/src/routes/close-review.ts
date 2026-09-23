import { Router, type IRouter } from "express";
import { z } from "zod";
import { prepareCloseReviewSchema, decideCloseReviewSchema, closeReviewListSchema, pilotProgressSchema, valopayRecordSchema } from "@workspace/valopay-schema";
import { caseAssignees } from "../lib/valopay-store";
import { requiredKey } from "../lib/contract";
import { withState } from "./valopay";
import { closeReviewList, pilotProgress, prepareCloseReview, decideCloseReview } from "../domain/close-review";

const router: IRouter = Router();
router.get("/v1/pilot/progress", async (req, res) => {
  res.json(await withState(req, res, (state, ctx) => pilotProgress(state, ctx.accessMode), false, pilotProgressSchema));
});
router.get("/v1/pilot/close-reviews", async (req, res) => {
  res.json(await withState(req, res, async (state, ctx) => ({
    ...closeReviewList(state),
    actor: ctx.actor,
    reviewers: (await caseAssignees(ctx)).filter(person => person.role === "Finance"),
    accessMode: ctx.accessMode,
    ownPrincipal: ctx.principalId,
  }), false, closeReviewListSchema));
});
router.post("/v1/pilot/close-reviews/prepare", async (req, res) => {
  requiredKey(req);
  const input = prepareCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => prepareCloseReview(state, ctx, input, await caseAssignees(ctx)), true, valopayRecordSchema));
});
router.post("/v1/pilot/close-reviews/:id/decision", async (req, res) => {
  requiredKey(req);
  const id = z.string().min(1).max(100).parse(req.params.id), input = decideCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => decideCloseReview(state, ctx, id, input), true, valopayRecordSchema));
});
export default router;
