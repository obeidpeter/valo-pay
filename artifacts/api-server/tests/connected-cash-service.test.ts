import assert from "node:assert/strict";
import {
  cashView,
  runCashAction,
} from "../src/domain/connected-cash-service.js";
import { makeRecord } from "../src/domain/records.js";
import type { Context, DomainState } from "../src/domain/types.js";

const now = "2026-09-21T10:00:00Z";
const operations: Context = {
  actor: "Sandbox Operations",
  role: "Operations",
  now,
};
const finance: Context = { actor: "Sandbox Finance", role: "Finance", now };
const state: DomainState = {
  merchant: {
    id: "lender-one",
    name: "Sample lender",
    shortName: "SL",
    segment: "cooperative",
    mode: "observation",
    status: "active",
    provider: "synthetic",
    monthlyVolume: 0,
    killSwitch: false,
    preDataReady: false,
    preLiveReady: false,
  },
  records: [],
  settings: { environment: "sandbox" },
};
const act = (
  action: string,
  ctx = operations,
  recordId?: string,
  data: Record<string, unknown> = {},
) =>
  runCashAction(state, ctx, {
    action,
    recordId,
    data,
    reason: "Verify the synthetic Cash Desk workflow",
  });
let checks = 0;
assert.equal(cashView(state, operations).initialised, false);
assert.equal(state.records.length, 0);
checks += 2;
assert.throws(() => act("cash.initialize"), /permission/i);
checks++;
for (const purpose of ["merchant_account_read", "erp_draft", "payroll_prepare"])
  makeRecord(state, "connected-consents", {
    status: "active",
    createdAt: now,
    data: {
      purpose,
      subjectId: "sme",
      entityId: "lender-one:sme",
      expiresAt: "2026-10-21T10:00:00Z",
    },
  });
act("cash.initialize");
assert.equal(cashView(state, operations).initialised, true);
checks++;
act("cash.forecast", operations, undefined, {
  downsideInflowBps: 6000,
  downsideDelayDays: 10,
});
assert.equal(cashView(state, operations).forecast.version, "sample-1");
checks++;
const erp = act("cash.erp.prepare").record!;
assert.equal(erp.status, "proposed");
checks++;
assert.throws(() => act("cash.erp.prepare"), /already has a draft/);
checks++;
assert.throws(() => act("cash.erp.review", operations, erp.id), /Finance/);
checks++;
act("cash.erp.review", finance, erp.id);
act("cash.erp.export", finance, erp.id);
assert.equal(erp.data.manifest.status, "not_posted");
checks++;
const vat = act("cash.vat.export", finance).record!;
assert.equal(vat.data.schedule.filingStatus, "not_submitted");
assert.equal(vat.data.schedule.status, "review_required");
checks += 2;
const payroll = act("cash.payroll.prepare").record!;
assert.equal(payroll.data.plan.fundingStatus, "ready_for_review");
checks++;
assert.throws(
  () => act("cash.payroll.approve", operations, payroll.id),
  /Finance/,
);
checks++;
act("cash.payroll.approve", finance, payroll.id);
act("cash.payroll.export", finance, payroll.id);
assert.equal(payroll.data.manifest.paymentStatus, "not_evidenced");
checks++;
act("cash.payroll.reconcile", finance, payroll.id, {
  itemId: "payroll-one",
  status: "succeeded",
});
act("cash.payroll.reconcile", finance, payroll.id, {
  itemId: "payroll-two",
  status: "unknown",
});
assert.equal(payroll.status, "partially_completed");
checks++;
assert.equal(payroll.data.manifest, undefined);
assert.equal(payroll.data.exportHistory.length, 1);
checks += 2;
const newExport = act("cash.payroll.export", finance, payroll.id);
assert.equal((newExport.data.manifest as { itemCount: number }).itemCount, 1);
checks++;
const read = state.records.find(
  (r) =>
    r.kind === "connected-consents" &&
    r.data.purpose === "merchant_account_read",
)!;
read.status = "revoked";
const revoked = cashView(state, finance);
assert.equal(revoked.accounts.length, 0);
assert.equal(revoked.forecast, null);
assert.equal(revoked.payrollPlans.length, 0);
checks += 3;
assert.throws(() => act("cash.forecast"), /permission/i);
checks++;
read.status = "active";
assert.throws(
  () =>
    act(
      "cash.payroll.export",
      { ...finance, now: "2026-09-21T12:00:00Z" },
      payroll.id,
    ),
  /stale/,
);
checks++;
const laterOperations = { ...operations, now: "2026-09-21T12:00:00Z" },
  laterFinance = { ...finance, now: "2026-09-21T12:00:00Z" };
act("cash.refresh_sample", laterOperations);
act("cash.payroll.refresh", laterOperations, payroll.id);
assert.equal(payroll.data.plan.approvalStatus, "draft");
assert.equal(payroll.data.plan.reviewVersion, 2);
checks += 2;
assert.equal(payroll.data.plan.items[0].status, "succeeded");
assert.equal(payroll.data.plan.items[1].status, "unknown");
assert.equal(payroll.data.revisions.length, 1);
checks += 3;
assert.throws(
  () => act("cash.payroll.export", laterFinance, payroll.id),
  /checker approval/,
);
checks++;
act("cash.payroll.approve", laterFinance, payroll.id);
const refreshedExport = act("cash.payroll.export", laterFinance, payroll.id);
assert.equal(
  (refreshedExport.data.manifest as { itemCount: number }).itemCount,
  1,
);
checks++;
const payrollGrant = state.records.find(
  (r) =>
    r.kind === "connected-consents" && r.data.purpose === "payroll_prepare",
)!;
payrollGrant.data.expiresAt = now;
assert.equal(cashView(state, laterFinance).payrollPlans.length, 0);
assert.throws(
  () => act("cash.payroll.export", laterFinance, payroll.id),
  /permission/i,
);
checks += 2;
payrollGrant.data.expiresAt = "2026-10-21T10:00:00Z";
assert.throws(
  () =>
    act(
      "cash.payroll.approve",
      { ...laterFinance, actor: operations.actor },
      payroll.id,
    ),
  /different maker and checker/,
);
checks++;
// A short fresh balance prevents a new export, but must not strand already-exported evidence.
const cashWorkspace = state.records.find(
  (r) => r.kind === "connected-cash-workspace",
)!;
cashWorkspace.data.workspace.accounts[0].availableMinor = 1;
act("cash.payroll.refresh", laterOperations, payroll.id);
assert.equal(payroll.data.plan.fundingStatus, "shortfall");
assert.equal(payroll.data.plan.approvalStatus, "draft");
assert.throws(
  () => act("cash.payroll.export", laterFinance, payroll.id),
  /checker approval/,
);
checks += 3;
act("cash.payroll.reconcile", laterFinance, payroll.id, {
  itemId: "payroll-two",
  status: "succeeded",
});
assert.equal(payroll.data.plan.items[1].status, "succeeded");
assert.equal(payroll.data.plan.approvalStatus, "draft");
checks += 2;
const originalBeneficiaryVersion =
  payroll.data.plan.items[2].beneficiaryVersion;
payroll.data.plan.items[2].beneficiaryVersion = "changed-after-approval";
assert.throws(
  () =>
    act("cash.payroll.reconcile", laterFinance, payroll.id, {
      itemId: "payroll-three",
      status: "succeeded",
    }),
  /approval is missing|frozen details changed/,
);
payroll.data.plan.items[2].beneficiaryVersion = originalBeneficiaryVersion;
checks++;
read.status = "revoked";
payrollGrant.status = "revoked";
const retained = cashView(state, laterFinance);
assert.equal(retained.accounts.length, 0);
assert.equal(retained.payrollPlans.length, 0);
assert.equal(retained.payrollReconciliation.length, 1);
assert.equal("availableMinor" in retained.payrollReconciliation[0]!, false);
assert.equal(
  "beneficiaryReference" in retained.payrollReconciliation[0]!.items[0]!,
  false,
);
assert.equal(cashView(state, laterOperations).payrollReconciliation.length, 0);
assert.throws(
  () => act("cash.payroll.export", laterFinance, payroll.id),
  /permission/i,
);
assert.throws(
  () =>
    act("cash.payroll.reconcile", laterOperations, payroll.id, {
      itemId: "payroll-three",
      status: "succeeded",
    }),
  /Finance/,
);
checks += 8;
act("cash.payroll.reconcile", laterFinance, payroll.id, {
  itemId: "payroll-three",
  status: "succeeded",
});
assert.equal(payroll.data.plan.items[2].status, "succeeded");
assert.equal(read.status, "revoked");
assert.equal(payrollGrant.status, "revoked");
checks += 3;
read.status = "active";
payrollGrant.status = "active";
const copied = structuredClone(payroll);
copied.id = "cross-entity";
copied.data.entityId = "other:sme";
state.records.push(copied);
assert.throws(
  () => act("cash.payroll.refresh", laterOperations, copied.id),
  /not found/,
);
checks++;
state.settings.environment = "production";
assert.throws(() => act("cash.forecast"), /synthetic sandbox/);
checks++;
console.log(
  `Cash Desk service: ${checks} lifecycle, permission, approval and export checks passed.`,
);
