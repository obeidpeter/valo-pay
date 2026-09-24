import { Router, type IRouter } from "express";
import { prepareCloseReviewSchema, decideCloseReviewSchema, closeReviewListSchema, pilotProgressSchema, valopayRecordSchema, pathId } from "@workspace/valopay-schema";
import { caseAssignees } from "../lib/valopay-store";
import { requiredKey } from "../lib/contract";
import { withState } from "./valopay";
import { closeReviewList, pilotProgress, prepareCloseReview, decideCloseReview } from "../domain/close-review";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);
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
  const id = pathId(req.params.id), input = decideCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => decideCloseReview(state, ctx, id, input), true, valopayRecordSchema));
});
export default router;
