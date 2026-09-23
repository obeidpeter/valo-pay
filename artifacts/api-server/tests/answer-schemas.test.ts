// Offline checks that the shared answer schemas (lib/valopay-schema) describe
// what the views and actions really produce (audit item 24): every connected
// action, Credit Desk scenario and review, Cash Desk step and permission state,
// and the pilot progress and close review views, both as the server builds them
// and as the console receives them after JSON. The API checks every answer
// against these schemas before it is sent, so a gap here would be a 500 there.
import assert from "node:assert/strict";
import type { ZodTypeAny } from "zod";
import { closeReviewListSchema, connectedActionResultSchema, connectedViewSchema, pilotProgressSchema } from "@workspace/valopay-schema";
import { seedMerchant } from "../src/lib/valopay-seed";
import { connectedActionSchema, connectedRevision, connectedView, runConnectedAction } from "../src/domain/connected";
import { executeAction } from "../src/domain";
import { bindCloseReviewBasis, closeReviewList, pilotProgress } from "../src/domain/close-review";
import type { Context, ValopayRecord } from "../src/domain/types";

let checks = 0;
/** The value as the server checks it and as the console reads it after JSON. */
function conforms(schema: ZodTypeAny, value: unknown, what: string) {
  for (const [form, candidate] of [["as built", value], ["after JSON", JSON.parse(JSON.stringify(value))]] as const) {
    const parsed = schema.safeParse(candidate);
    assert.ok(parsed.success, `${what} ${form}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))}`);
    checks += 1;
  }
}

const now = "2026-09-21T10:00:00.000Z";
const admin: Context = { now, role: "Admin", actor: "Sandbox Admin", principalId: "browser" };
const finance: Context = { ...admin, role: "Finance", actor: "Sandbox Finance" };
const compliance: Context = { ...admin, role: "Compliance reviewer", actor: "Sandbox Compliance reviewer" };
const readOnly: Context = { ...admin, role: "Read-only", actor: "Sandbox Read-only" };
const state = seedMerchant("tenant-answer-schemas");

/** Runs an action as the route does and checks its answer and the workspace view for every role. */
function act(action: string, data: Record<string, unknown> = {}, recordId?: string, context = admin) {
  const input = connectedActionSchema.parse({ action, data, recordId, reason: "Check the answer shapes", expectedRevision: connectedRevision(state) });
  const record = runConnectedAction(state, context, input);
  conforms(connectedActionResultSchema, { message: "Sample workspace updated.", record, mode: "synthetic", externalInstructionPerformed: false }, `${action} answer`);
  for (const viewer of [admin, finance, compliance, readOnly]) conforms(connectedViewSchema, connectedView(state, viewer), `the view after ${action} for ${viewer.role}`);
  return record as ValopayRecord & { record?: ValopayRecord };
}

// The empty workspace, before anything is granted.
for (const viewer of [admin, finance, readOnly]) conforms(connectedViewSchema, connectedView(state, viewer), `the first view for ${viewer.role}`);

// Credit Desk: every scenario, a custom schedule, a review, and a view whose permission was revoked.
const applicant = state.records.find((record) => record.kind === "customers" && record.reference === "DEMO-C1001")!;
const accountRead = act("consent.grant", { purpose: "account_read", subjectId: applicant.id, days: 30 });
const creditGrant = act("consent.grant", { purpose: "credit_assessment", subjectId: applicant.id, days: 30 });
for (const scenario of ["thin_file", "stale", "refused", "high_commitments", "ready"]) act("credit.assess", { customerId: applicant.id, scenario });
const latest = act("credit.assess", { customerId: applicant.id, scenario: "ready", principalKobo: 24_000_000, repaymentKobo: 9_000_000, termMonths: 3 });
act("credit.review", { expectedAssessmentVersion: latest.data.result.version, outcome: "request_information", rationale: "The applicant's income evidence needs a second month.", applicantExplanation: "Please share another month of statements for review.", reasonCodes: ["EVIDENCE_MORE"] }, latest.id, finance);
act("consent.revoke", {}, creditGrant.id, compliance);
assert.ok(connectedView(state, admin).credit.assessments.every((item) => item.permissionRestricted), "a revoked permission restricts every assessment");
checks += 1;
void accountRead;

// Pay-by-bank: a checkout that is cancelled, one confirmed then refunded by a second person, and one reversed.
const openDues = () => connectedView(state, admin).payments.dues.filter((due) => !due.blocked);
const cancelled = act("payment.create", { dueItemId: openDues()[0]!.id, amountKobo: 500_000 });
act("payment.cancel", {}, cancelled.id);
const refundDue = openDues()[0]!;
const refunded = act("payment.create", { dueItemId: refundDue.id, amountKobo: refundDue.outstandingKobo });
act("payment.authorise", {}, refunded.id);
act("payment.return", {}, refunded.id);
act("payment.outcome", { outcome: "unknown" }, refunded.id);
act("payment.outcome", { outcome: "confirmed" }, refunded.id);
act("payment.refund_request", {}, refunded.id);
act("payment.refund_confirm", {}, refunded.id, finance);
const reverseDue = openDues()[0]!;
const reversed = act("payment.create", { dueItemId: reverseDue.id, amountKobo: reverseDue.outstandingKobo });
act("payment.authorise", {}, reversed.id);
act("payment.outcome", { outcome: "confirmed" }, reversed.id);
act("payment.reverse", {}, reversed.id, finance);

// Cash Desk: set up, forecast, an accounting draft reviewed and exported, a VAT schedule, and a payroll plan
// approved, exported, reconciled and refreshed; then the views a revoked permission leaves.
const smeGrants = ["merchant_account_read", "erp_draft", "payroll_prepare"].map((purpose) => act("consent.grant", { purpose, subjectId: "sme", days: 30 }));
act("cash.initialize");
const again = act("cash.initialize");
assert.equal(again.record, undefined, "setting up twice answers without a record");
checks += 1;
act("cash.refresh_sample");
act("cash.forecast", { bufferMinor: 150_000_000, downsideInflowBps: 6000, downsideDelayDays: 10 });
const erp = act("cash.erp.prepare").record!;
act("cash.erp.review", {}, erp.id, finance);
act("cash.erp.export", {}, erp.id, finance);
act("cash.vat.export", {}, undefined, finance);
const payroll = act("cash.payroll.prepare").record!;
act("cash.payroll.approve", {}, payroll.id, finance);
act("cash.payroll.export", {}, payroll.id, finance);
act("cash.payroll.reconcile", { itemId: "payroll-one", status: "succeeded" }, payroll.id, finance);
act("cash.payroll.reconcile", { itemId: "payroll-two", status: "unknown" }, payroll.id, finance);
act("cash.payroll.refresh", {}, payroll.id);
for (const grant of smeGrants) act("consent.revoke", {}, grant.id, compliance);
assert.equal(connectedView(state, finance).cash.payrollReconciliation.length, 1, "Finance still sees the outcomes it must reconcile");
checks += 1;
// Later, every permission has expired.
conforms(connectedViewSchema, connectedView(state, { ...admin, now: "2027-01-01T00:00:00.000Z" }), "the view once every permission expired");

// Pilot progress and the close review list, before and after a daily close.
for (const accessMode of ["sandbox", "staff"]) conforms(pilotProgressSchema, pilotProgress(state, accessMode), `pilot progress on a ${accessMode} host`);
const reviewList = () => ({ ...closeReviewList(state), actor: admin.actor, reviewers: [{ actor: "Sandbox Finance", name: "Demo Finance", role: "Finance" }], accessMode: "sandbox", ownPrincipal: "browser" });
conforms(closeReviewListSchema, reviewList(), "the close review list before a close");
const before = new Set(state.records.map((record) => record.id));
executeAction(state, admin, { action: "daily_close", reason: "Check the answer shapes" });
for (const close of state.records.filter((record) => record.kind === "closes" && !before.has(record.id))) bindCloseReviewBasis(state, close);
conforms(closeReviewListSchema, reviewList(), "the close review list after a close");
conforms(pilotProgressSchema, pilotProgress(state), "pilot progress after a close");

console.log(`Answer schema checks passed (${checks} checks): every connected action, Credit Desk scenario and review, pay-by-bank path, Cash Desk step and permission state, pilot progress and the close review list, as built and after JSON.`);
