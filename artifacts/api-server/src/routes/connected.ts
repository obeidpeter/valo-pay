import { Router, type IRouter } from "express";
import { connectedActionResultFor, connectedViewSchema } from "@workspace/valopay-schema";
import {
  inWorkspace,
  loadState,
  saveState,
  settleChanges,
  appendAudit,
  auditObject,
  findIdempotency,
  findStoredAnswer,
  saveIdempotency,
  receiptOf,
  fail,
  completeOperation,
} from "../lib/valopay-store";
import { requestFingerprint } from "../lib/digests";
import { contractAnswer, lenderQuery, replayedAnswer, requiredKey } from "../lib/contract";
import {
  connectedActionSchema,
  connectedView,
  runConnectedAction,
} from "../domain/connected";
import { ConnectedCashError } from "../domain/connected-cash";
import { CreditDomainError } from "../domain/connected-credit";
import { routerOptions } from "./router-options";
const router: IRouter = Router(routerOptions);
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
        const receipt = receiptOf(req, merchantId, key, "connected"),
          fingerprint = requestFingerprint({ input, actor: ctx.actor });
        // The one shape this action answers with, of this lender: an outcome never passes for a record.
        const answer = connectedActionResultFor(input.action, merchantId);
        const replay = async (prior: { request_hash: string; response: unknown }) => {
          if (prior.request_hash !== fingerprint)
            fail("This request key was already used for different input.", 409);
          // The action was saved with this receipt: never answered as saving nothing, even when it no longer matches.
          const saved = replayedAnswer(req, answer, prior.response);
          await completeOperation(ctx, saved);
          return saved;
        };
        // A repeat is answered from its receipt without loading the lender; the lookup is made again once the journal entry is held.
        const stored = await findStoredAnswer(ctx, merchantId, receipt.id, receipt.earlier);
        if (stored) return replay(stored);
        const state = await loadState(ctx, merchantId, "update");
        const prior = await findIdempotency(ctx, receipt.id, receipt.earlier);
        if (prior) return replay(prior);
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
        const result = contractAnswer(answer, {
          message: "Sample workspace updated.",
          record,
          mode: "synthetic",
          externalInstructionPerformed: false,
        });
        // The object is the record the action changed or answers with, never an unrelated one the body named.
        appendAudit(
          state,
          ctx,
          input.action,
          auditObject(ctx, state, { body: input.recordId, answer: result }, "connected-workspace"),
          input.reason,
          {
            ...changes,
            mode: "synthetic",
            externalInstructionPerformed: false,
          },
        );
        await saveState(ctx, state);
        await saveIdempotency(ctx, receipt.id, fingerprint, result);
        return result;
      },
      "write",
    ),
  );
});
export default router;
