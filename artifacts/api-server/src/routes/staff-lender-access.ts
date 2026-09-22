import { Router, type IRouter } from "express";
import { z } from "zod";
import { staffLenderAccessInputSchema } from "@workspace/valopay-schema";
import { inWorkspace, updateStaffLenders } from "../lib/valopay-store";

const router: IRouter = Router();
router.patch("/v1/team/members/:id/lenders", async (req, res) => {
  const id = z.string().min(1).max(100).parse(req.params.id), input = staffLenderAccessInputSchema.parse(req.body);
  res.json(await inWorkspace(req, res, ctx => updateStaffLenders(ctx, id, input), "team"));
});
export default router;
