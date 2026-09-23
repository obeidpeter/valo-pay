import { Router, type IRouter } from "express";
import { z } from "zod";
import { staffLenderAccessInputSchema, staffLenderAccessSchema } from "@workspace/valopay-schema";
import { inWorkspace, updateStaffLenders } from "../lib/valopay-store";
import { contractAnswer } from "../lib/contract";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);
router.patch("/v1/team/members/:id/lenders", async (req, res) => {
  const id = z.string().min(1).max(100).parse(req.params.id), input = staffLenderAccessInputSchema.parse(req.body);
  res.json(await inWorkspace(req, res, async ctx => contractAnswer(staffLenderAccessSchema, await updateStaffLenders(ctx, id, input)), "team"));
});
export default router;
