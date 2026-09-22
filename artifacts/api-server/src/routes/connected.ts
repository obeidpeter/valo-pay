import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  inWorkspace,
  loadState,
  saveState,
  appendAudit,
  findIdempotency,
  saveIdempotency,
  digest,
  canonical,
  fail,
  completeOperation,
} from "../lib/valopay-store";
import {
  connectedActionSchema,
  connectedView,
  runConnectedAction,
} from "../domain/connected";
import { ConnectedCashError } from "../domain/connected-cash";
import { CreditDomainError } from "../domain/connected-credit";
const router: IRouter = Router();
const query = z.object({ merchantId: z.string().min(1).max(100) });
router.get("/v1/connected", async (req, res) => {
  const { merchantId } = query.parse(req.query);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        connectedView(await loadState(ctx, merchantId, "share"), ctx),
      "read",
    ),
  );
});
router.post("/v1/connected/actions", async (req, res) => {
  const { merchantId } = query.parse(req.query),
    input = connectedActionSchema.parse(req.body);
  const key = z.string().min(8).max(200).parse(req.header("Idempotency-Key"));
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, merchantId, "update");
        const id = digest(`connected:${merchantId}:${key}`),
          fingerprint = digest(canonical({ input, actor: ctx.actor }));
        const prior = await findIdempotency(ctx, id);
        if (prior) {
          if (prior.request_hash !== fingerprint)
            fail("This request key was already used for different input.", 409);
          await completeOperation(ctx, prior.response);
          return prior.response;
        }
        const before = digest(canonical(state));
        let record;
        try {
          record = runConnectedAction(state, ctx, input);
        } catch (error) {
          if (error instanceof CreditDomainError)
            fail(error.message, error.status);
          if (error instanceof ConnectedCashError) fail(error.message, 400);
          throw error;
        }
        appendAudit(
          state,
          ctx,
          input.action,
          input.recordId || "connected-workspace",
          input.reason,
          {
            beforeDigest: before,
            afterDigest: digest(canonical(state)),
            mode: "synthetic",
            externalInstructionPerformed: false,
          },
        );
        await saveState(ctx, state);
        const result = {
          message: "Sample workspace updated.",
          record,
          mode: "synthetic",
          externalInstructionPerformed: false,
        };
        await saveIdempotency(ctx, id, fingerprint, result);
        return result;
      },
      "write",
    ),
  );
});
export default router;
