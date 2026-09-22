import { Router, raw, type IRouter } from "express";
import { z } from "zod";
import { CreateRecordResponse } from "@workspace/api-zod";
import { sourceProfileInputSchema, sourceBatchQualitySchema, paystackFixtureInputSchema, providerReplayInputSchema, sourceManifestInputSchema, sourceCompletenessSchema, businessDateSchema } from "@workspace/valopay-schema";
import { withState } from "./valopay";
import { saveSourceProfile, sourceQuality } from "../domain/source-quality";
import { saveSourceManifest } from "../domain/source-completeness";
import { providerEventView, receivePaystackEvent, replayProviderEvent, runPaystackFixture } from "../providers/paystack-inbox";
import { parsePaystackTestWebhook, PaystackError } from "../providers/paystack";
import type { DomainState, Context } from "../domain/types";

const router: IRouter = Router();
const eventViewSchema = z.object({ id: z.string(), name: z.string(), status: z.string(), reference: z.string(), amountKobo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), createdAt: z.string(), updatedAt: z.string(), mode: z.enum(["fixture", "test"]), message: z.string(), deliveryCount: z.number().int().min(0), replayCount: z.number().int().min(0), financialRecordsCreated: z.literal(0) });
const sourcesResponse = z.object({
  completeness: sourceCompletenessSchema,
  profiles: z.array(CreateRecordResponse.extend({ delivery: z.object({ status: z.string(), missedDeliveries: z.number().int().min(0), nextExpectedAt: z.string(), lastCommittedAt: z.string().nullable(), lastBatchId: z.string().nullable() }) })),
  batches: z.array(z.object({ id: z.string(), name: z.string(), source: z.string(), sourceBatchId: z.string(), kind: z.string(), status: z.string(), createdAt: z.string(), quality: sourceBatchQualitySchema })),
  summary: z.object({ lateSources: z.number().int().min(0), duplicateRows: z.number().int().min(0), conflictRows: z.number().int().min(0), batchesNeedingReview: z.number().int().min(0) }),
  paystack: z.object({ mode: z.literal("test_only"), externalConnectionVerified: z.literal(false), canRunFixtures: z.boolean(), state: z.literal("configuration_required"), message: z.string(), events: z.array(eventViewSchema), total: z.number().int().min(0), quarantined: z.number().int().min(0), duplicates: z.number().int().min(0) }),
});
router.get("/v1/sources", async (req, res) => {
  const businessDate = businessDateSchema.optional().parse(req.query.businessDate);
  const result = await withState(req, res, (state, ctx) => {
    const events = state.records.filter(r => r.kind === "provider-events").sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return { ...sourceQuality(state, ctx.now, businessDate), paystack: { mode: "test_only", externalConnectionVerified: false, canRunFixtures: ["Admin", "Operations", "Finance"].includes(ctx.role), state: "configuration_required", message: "A Paystack account, test credentials and an operator-provisioned connection are required for an external test. Local fixture results do not verify a Paystack connection.", events: events.slice(0,50).map(providerEventView), total: events.length, quarantined: events.filter(e => e.status === "quarantined").length, duplicates: events.reduce((sum,e) => sum + Math.max(0, Number(e.data.deliveryCount || 0) - 1), 0) } };
  }, false, sourcesResponse);
  res.json(sourcesResponse.parse(result));
});
router.post("/v1/sources/profiles", async (req, res) => {
  const input = sourceProfileInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => saveSourceProfile(state, ctx, input), true, CreateRecordResponse));
});
router.post("/v1/sources/manifests", async (req, res) => {
  z.string().min(8).max(200).parse(req.header("Idempotency-Key"));
  const input = sourceManifestInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => saveSourceManifest(state, ctx, input), true, CreateRecordResponse));
});
router.post("/v1/sources/profiles/:id/save", async (req, res) => {
  const input = sourceProfileInputSchema.parse(req.body), id = z.string().min(1).max(100).parse(req.params.id);
  res.json(await withState(req, res, (state, ctx) => saveSourceProfile(state, ctx, input, id), true, CreateRecordResponse));
});
router.post("/v1/sources/paystack/fixtures", async (req, res) => {
  const input = paystackFixtureInputSchema.parse(req.body);
  const schema = z.object({ accepted: z.boolean(), duplicate: z.boolean(), event: eventViewSchema });
  res.json(await withState(req, res, (state, ctx) => { const result = runPaystackFixture(state, ctx, input.scenario); return { ...result, event: providerEventView(result.event) }; }, true, schema));
});
router.post("/v1/sources/events/:id/replay", async (req, res) => {
  const input = providerReplayInputSchema.parse(req.body), id = z.string().min(1).max(100).parse(req.params.id);
  res.json(await withState(req, res, (state, ctx) => providerEventView(replayProviderEvent(state, ctx, id, input.expectedUpdatedAt, input.reason)), true, eventViewSchema));
});
export default router;

/** Server-only resolver must lock and persist the mapped lender transaction. Never resolve a browser workspace or query-string merchant. */
export type PaystackConnectionTransaction = <T>(connectionId: string, apply: (connection: { state: DomainState; context: Context; secretKey: string }) => T | Promise<T>) => Promise<T>;
/** Mount before JSON parsing. The only admitted body is authenticated raw application/json bytes. */
export function createPaystackIngress(transact: PaystackConnectionTransaction): IRouter {
  const ingress = Router();
  ingress.post("/v1/providers/paystack/:connectionId/events", raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    const connectionId = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.connectionId);
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error("A signed JSON body is required."), { status: 400 });
    try {
      const result = await transact(connectionId, ({ state, context, secretKey }) => {
        const event = parsePaystackTestWebhook(req.body, req.header("x-paystack-signature"), secretKey);
        const receipt = receivePaystackEvent(state, context, event, { connectionId, mode: "test" });
        return { accepted: true, duplicate: receipt.duplicate };
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof PaystackError) throw Object.assign(new Error(error.message), { status: error.code === "invalid_signature" ? 401 : error.code === "configuration" ? 503 : 400 });
      throw error;
    }
  });
  return ingress;
}
