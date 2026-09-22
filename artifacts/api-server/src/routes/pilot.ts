import { Router, type IRouter } from "express";
import { z } from "zod";
import { CreateRecordResponse } from "@workspace/api-zod";
import { getAuth } from "@clerk/express";
import { reverificationErrorResponse } from "@clerk/shared/authorization-errors";
import { staffMode } from "../lib/staff-access";
import {
  batchInputSchema,
  caseInputSchema,
  invitationInputSchema,
  lenderInputSchema,
  membershipInputSchema,
} from "@workspace/valopay-schema";
import {
  inWorkspace,
  loadState,
  listOperations,
  cancelOperation,
  caseAssignees,
  staffDirectory,
  inviteStaff,
  updateStaff,
  revokeInvitation,
  acceptStaffInvitation,
  createPilotLender,
  fail,
} from "../lib/valopay-store";
import { withState } from "./valopay";
import {
  batchView,
  saveImportBatch,
  commitImportBatch,
  coordinateCase,
} from "../domain/pilot-workflow";

const router: IRouter = Router();
const query = z.object({
  merchantId: z.string().min(1).max(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const idOf = (value: unknown) => z.string().min(1).max(100).parse(value);
const versionBody = z
  .object({ expectedUpdatedAt: z.string().datetime() })
  .strict();
router.post("/v1/team/verify", async (req, res) => {
  if (!staffMode()) fail("Staff access is not enabled on this host.", 403);
  const auth = getAuth(req, { acceptsToken: "session_token" });
  if (!auth.userId) fail("Sign in to verify your identity.", 401);
  if (!auth.factorVerificationAge || auth.factorVerificationAge[1] < 0)
    fail(
      "Enrol and verify a second authentication factor in Account security first.",
      403,
    );
  if (!auth.has({ reverification: "strict_mfa" })) {
    const response = reverificationErrorResponse("strict_mfa");
    res.status(response.status).json(await response.json());
    return;
  }
  res.json({ message: "Identity verified." });
});
router.get("/v1/operations", async (req, res) => {
  const q = query.parse(req.query);
  res.json(
    await inWorkspace(
      req,
      res,
      (ctx) => listOperations(ctx, q.merchantId, q.offset),
      "read",
    ),
  );
});
router.post("/v1/operations/:id/cancel", async (req, res) => {
  const q = query.parse(req.query),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(req, res, (ctx) =>
      cancelOperation(ctx, q.merchantId, id),
    ),
  );
});
router.get("/v1/pilot/journey", async (req, res) => {
  const q = query.parse(req.query);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        const count = (kind: string, statuses?: string[]) =>
          state.records.filter(
            (r) =>
              r.kind === kind && (!statuses || statuses.includes(r.status)),
          ).length;
        return {
          lender: state.merchant,
          accessMode: ctx.accessMode,
          actor: ctx.actor,
          syntheticOnly: true,
          counts: {
            customers: count("customers"),
            batches: count("import-batches", ["committed"]),
            receipts: count("payments"),
            openCases: state.records.filter(
              (r) =>
                r.kind === "exceptions" &&
                !["closed", "resolved"].includes(r.status),
            ).length,
            unassignedCases: state.records.filter(
              (r) =>
                r.kind === "exceptions" &&
                !["closed", "resolved"].includes(r.status) &&
                !r.data.case?.assignee,
            ).length,
            closes: count("closes"),
            exports: count("exports", ["ready"]),
          },
        };
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/lenders", async (req, res) => {
  const input = lenderInputSchema.parse(req.body),
    key = z.string().min(8).max(200).parse(req.header("Idempotency-Key"));
  res.json(
    await inWorkspace(
      req,
      res,
      (ctx) => createPilotLender(ctx, input, key),
      "team",
    ),
  );
});
router.get("/v1/pilot/batches", async (req, res) => {
  const q = query.parse(req.query);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        const all = state.records
          .filter((r) => r.kind === "import-batches")
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              b.id.localeCompare(a.id),
          );
        return {
          items: all
            .slice(q.offset, q.offset + 25)
            .map((batch) => batchView(batch)),
          total: all.length,
          offset: q.offset,
        };
      },
      "read",
    ),
  );
});
router.get("/v1/pilot/batches/:id", async (req, res) => {
  const q = query.parse(req.query),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        if (!["Admin", "Operations", "Finance"].includes(ctx.role))
          fail("An import operator role is required to open source rows.", 403);
        const batch = state.records.find(
          (r) => r.kind === "import-batches" && r.id === id,
        );
        if (!batch) fail("Import batch not found.", 404);
        return {
          batch,
          revisions: state.records.filter(
            (r) => r.kind === "import-revisions" && r.data.batchId === id,
          ),
        };
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/batches", async (req, res) => {
  const input = batchInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => saveImportBatch(state, ctx, input),
      true,
      CreateRecordResponse,
    ),
  );
});
router.post("/v1/pilot/batches/:id/save", async (req, res) => {
  const input = batchInputSchema.parse(req.body),
    id = idOf(req.params.id);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => saveImportBatch(state, ctx, input, id),
      true,
      CreateRecordResponse,
    ),
  );
});
router.post("/v1/pilot/batches/:id/commit", async (req, res) => {
  const input = versionBody.parse(req.body),
    id = idOf(req.params.id);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) =>
        commitImportBatch(state, ctx, id, input.expectedUpdatedAt),
      true,
      CreateRecordResponse,
    ),
  );
});
router.get("/v1/pilot/cases/:id", async (req, res) => {
  const q = query.parse(req.query),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share"),
          record = state.records.find(
            (r) => r.kind === "exceptions" && r.id === id,
          );
        if (!record) fail("Exception not found.", 404);
        return {
          record,
          assignees: await caseAssignees(ctx),
          events: state.records.filter(
            (r) => r.kind === "case-events" && r.data.exceptionId === id,
          ),
          evidence: state.records
            .filter(
              (r) =>
                [
                  "customers",
                  "mandates",
                  "due-items",
                  "attempts",
                  "payments",
                  "observations",
                  "allocations",
                  "settlement-batches",
                  "evidence",
                  "closes",
                  "exports",
                  "policies",
                  "notifications",
                ].includes(r.kind) &&
                (!record.customerId ||
                  !r.customerId ||
                  r.customerId === record.customerId),
            )
            .map((r) => ({
              id: r.id,
              name: r.name,
              reference: r.reference,
              kind: r.kind,
            })),
        };
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/cases/:id", async (req, res) => {
  const input = caseInputSchema.parse(req.body),
    id = idOf(req.params.id);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        coordinateCase(state, ctx, id, input, await caseAssignees(ctx)),
      true,
      CreateRecordResponse,
    ),
  );
});
router.get("/v1/team", async (req, res) =>
  res.json(await inWorkspace(req, res, staffDirectory, "read")),
);
router.post("/v1/team/invitations", async (req, res) => {
  const input = invitationInputSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      (ctx) => inviteStaff(ctx, input.email, input.role),
      "team",
    ),
  );
});
router.post("/v1/team/invitations/:id/revoke", async (req, res) =>
  res.json(
    await inWorkspace(
      req,
      res,
      (ctx) => revokeInvitation(ctx, idOf(req.params.id)),
      "team",
    ),
  ),
);
router.patch("/v1/team/members/:id", async (req, res) => {
  const input = membershipInputSchema.parse(req.body),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(req, res, (ctx) => updateStaff(ctx, id, input), "team"),
  );
});
router.post("/v1/team/accept", async (req, res) => {
  const input = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(req.body);
  res.json(await acceptStaffInvitation(req, input.token));
});
export default router;
