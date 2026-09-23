import { Router, type IRouter } from "express";
import { connectedActionResultSchema, connectedViewSchema } from "@workspace/valopay-schema";
import {
  inWorkspace,
  loadState,
  saveState,
  settleChanges,
  appendAudit,
  findIdempotency,
  saveIdempotency,
  digest,
  fail,
  completeOperation,
} from "../lib/valopay-store";
import { requestFingerprint } from "../lib/digests";
import { contractAnswer, lenderQuery, requiredKey } from "../lib/contract";
import {
  connectedActionSchema,
  connectedView,
  runConnectedAction,
} from "../domain/connected";
import { ConnectedCashError } from "../domain/connected-cash";
import { CreditDomainError } from "../domain/connected-credit";
const router: IRouter = Router();
router.get("/v1/connected", async (req, res) => {
  const { merchantId } = lenderQuery(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        contractAnswer(
          connectedViewSchema,
          connectedView(await loadState(ctx, merchantId, "share"), ctx),
        ),
      "read",
    ),
  );
});
router.post("/v1/connected/actions", async (req, res) => {
  const key = requiredKey(req),
    { merchantId } = lenderQuery(req),
    input = connectedActionSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, merchantId, "update");
        const id = digest(`connected:${merchantId}:${key}`),
          fingerprint = requestFingerprint({ input, actor: ctx.actor });
        const prior = await findIdempotency(ctx, id);
        if (prior) {
          if (prior.request_hash !== fingerprint)
            fail("This request key was already used for different input.", 409);
          // A receipt saved by an earlier build is checked like a fresh answer.
          const receipt = contractAnswer(connectedActionResultSchema, prior.response);
          await completeOperation(ctx, receipt);
          return receipt;
        }
        let record;
        try {
          record = runConnectedAction(state, ctx, input);
        } catch (error) {
          if (error instanceof CreditDomainError)
            fail(error.message, error.status);
          if (error instanceof ConnectedCashError) fail(error.message, 400);
          throw error;
        }
        // Versions advance first, so the answer carries them; it is checked before anything is saved.
        const changes = settleChanges(ctx, state);
        const result = contractAnswer(connectedActionResultSchema, {
          message: "Sample workspace updated.",
          record,
          mode: "synthetic",
          externalInstructionPerformed: false,
        });
        appendAudit(
          state,
          ctx,
          input.action,
          input.recordId || "connected-workspace",
          input.reason,
          {
            ...changes,
            mode: "synthetic",
            externalInstructionPerformed: false,
          },
        );
        await saveState(ctx, state);
        await saveIdempotency(ctx, id, fingerprint, result);
        return result;
      },
      "write",
    ),
  );
});
export default router;
