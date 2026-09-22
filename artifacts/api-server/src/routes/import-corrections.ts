import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  importCorrectionPreviewInputSchema,
  importCorrectionProposalInputSchema,
  importCorrectionDecisionInputSchema,
  importCorrectionPreviewSchema,
  importCorrectionViewSchema,
  importCorrectionsResponseSchema,
} from "@workspace/valopay-schema";
import { withState } from "./valopay";
import { caseAssignees } from "../lib/valopay-store";
import {
  listImportCorrections,
  previewImportCorrection,
  proposeImportCorrection,
  decideImportCorrection,
} from "../domain/import-corrections";
const router: IRouter = Router();
const key = (value: unknown) => z.string().min(8).max(200).parse(value);
router.get("/v1/pilot/import-corrections", async (req, res) => {
  const batchId = z.string().min(1).max(100).parse(req.query.batchId);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) => ({
        ...listImportCorrections(state, ctx, batchId),
        reviewers: (await caseAssignees(ctx)).filter(
          (person) => person.role === "Finance",
        ),
      }),
      false,
      importCorrectionsResponseSchema,
    ),
  );
});
router.post("/v1/pilot/import-corrections/preview", async (req, res) => {
  const input = importCorrectionPreviewInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => previewImportCorrection(state, ctx, input),
      false,
      importCorrectionPreviewSchema,
    ),
  );
});
router.post("/v1/pilot/import-corrections", async (req, res) => {
  key(req.header("Idempotency-Key"));
  const input = importCorrectionProposalInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        proposeImportCorrection(state, ctx, input, await caseAssignees(ctx)),
      true,
      importCorrectionViewSchema,
    ),
  );
});
router.post("/v1/pilot/import-corrections/:id/decision", async (req, res) => {
  key(req.header("Idempotency-Key"));
  const id = z.string().min(1).max(100).parse(req.params.id),
    input = importCorrectionDecisionInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        decideImportCorrection(state, ctx, id, input, await caseAssignees(ctx)),
      true,
      importCorrectionViewSchema,
    ),
  );
});
export default router;
