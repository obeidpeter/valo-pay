// Golden tests for the spec gaps closed after the first review: RET-03 decision
// records, REC-07 close report, RET-06 uplift report with its 90% interval and
// BIL-01 billable collections (TRD v1.1 sections 5.6, 5.8, 5.15, 6.6 and 7.5).
import assert from "node:assert/strict";
import { DAY, HOUR, addAttempt, addHoliday, addNotice, addObservation, ctxAt, liveFixture, toWat, wat } from "./helpers.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { buildReports, upliftReport, billableCollection } from "../src/domain/reports.js";
import { latestDecisionFor } from "../src/domain/policy-engine.js";
import { positionFor } from "../src/domain/close.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { customerTimeline } from "../src/domain/timeline.js";
import type { DomainState, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const decisionsFor = (state: DomainState, due: ValopayRecord) => recordsOf(state, "retry-decisions").filter((item) => item.data.dueItemId === due.id);

// ---------- RET-03: every close records the decision with its version, row, inputs, time and notice; unchanged decisions are not repeated ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "decisions" });
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  const notice = addNotice(state, due, wat("2027-06-28T09:00:08"));
  failed.data.noticeId = notice.id;
  const first = reconcile(state, ctxAt(wat("2027-06-28T09:01:00"), "Finance"));
  const recorded = decisionsFor(state, due);
  assert.equal(recorded.length, 1, "one decision record after the first close");
  const decision = recorded[0]!;
  assert.equal(decision.status, "recorded");
  assert.equal(decision.customerId, due.customerId, "the decision sits on the customer timeline");
  assert.equal(decision.data.decision, "would_schedule");
  assert.equal(decision.data.rule, "plan");
  assert.equal(decision.data.policyId, policy.id);
  assert.equal(decision.data.policyVersion, 1, "policy version recorded");
  assert.equal(decision.data.attemptId, failed.id, "the failed attempt it follows");
  assert.equal(toWat(decision.data.nextAt), "2027-06-30T06:16:00", "scheduled time recorded");
  assert.equal(decision.data.inputs.code, "INSUFFICIENT_FUNDS");
  assert.equal(decision.data.inputs.attemptNumber, 1);
  assert.equal(decision.data.inputs.ceiling, 3);
  assert.deepEqual(decision.data.inputs.noticeEvidence, { noticeId: notice.id, acceptedAt: notice.data.acceptedAt }, "notice evidence recorded");
  assert.deepEqual((decision.data.inputs.calendar as { holidaysApplied: string[] }).holidaysApplied, [], "calendar inputs recorded");
  assert.equal(decision.data.noticeRequired!.purpose, "failed_debit");
  assert.equal(decision.data.noticeRequired!.evidenced, true);
  assert.equal(toWat(decision.data.noticeRequired!.requiredBy), "2027-06-29T06:16:00", "the notice it requires, due 24 hours before the attempt");
  assert.equal(decision.data.experimentArm, null, "no experiment enrolled: the arm is recorded as null");
  assert.equal(first.data.retryDecisionsRecorded >= 1, true);
  checks += 17;

  reconcile(state, ctxAt(wat("2027-06-28T12:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, 1, "the same decision at a later close is not written twice");
  addHoliday(state, "2027-06-30");
  reconcile(state, ctxAt(wat("2027-06-29T07:00:00"), "Finance"));
  const moved = decisionsFor(state, due);
  assert.equal(moved.length, 2, "a changed plan is a new decision");
  assert.equal(toWat(moved[1]!.data.nextAt), "2027-07-01T06:00:00", "the holiday rolls the plan to Thursday at the window start");
  assert.deepEqual((moved[1]!.data.inputs.calendar as { holidaysApplied: string[] }).holidaysApplied, ["2027-06-30"], "the holiday that moved the plan is recorded");
  assert.equal(moved[1]!.data.previousDecisionId, moved[0]!.id, "decisions chain to the one they replace");
  assert.equal(latestDecisionFor(state, due.id)?.id, moved[1]!.id);
  check(customerTimeline(state, due.customerId).events.some((event) => event.kind === "retry-decisions"), "AUD-01: the timeline carries every retry decision");
  const before = structuredClone(state);
  moved[0]!.data.reason = "edited";
  assert.throws(() => assertFinalState(before, state, state.merchant.id), /immutable/, "decision records are immutable evidence");
  checks += 7;
}

// ---------- RET-03 and 6.3 row 8: a notice deadline that passes unevidenced defers the attempt and raises the exception ----------
{
  const { state, due } = liveFixture({ merchantId: "deferral" });
  reconcile(state, ctxAt(wat("2027-06-28T10:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).at(-1)!.data.decision, "would_schedule", "planned, notice pending");
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 0, "no exception before the deadline");
  reconcile(state, ctxAt(wat("2027-06-29T06:17:00"), "Finance"));
  const deferred = decisionsFor(state, due).at(-1)!;
  assert.equal(deferred.data.decision, "defer");
  assert.equal(deferred.data.rule, "notice_not_evidenced");
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 1, "one notice-not-evidenced exception with the Operations owner");
  reconcile(state, ctxAt(wat("2027-06-29T08:00:00"), "Finance"));
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 1, "the exception is not duplicated by the next close");
  checks += 6;
}

// ---------- RET-05: the arm is recorded on the decision once enrolment assigns it ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "arm-on-decision" });
  makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.5, minPerArm: 1, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z" } });
  reconcile(state, ctxAt(wat("2027-06-28T10:00:00"), "Finance"));
  const decision = decisionsFor(state, due).at(-1)!;
  assert.ok(["engine", "holdout"].includes(String(decision.data.experimentArm)), "the arm assigned at the first failure is on the decision");
  assert.equal(decision.data.experimentArm, due.data.experimentArm);
  checks += 2;
}

// ---------- REC-07: the daily close report ----------
{
  const { state, due, customer } = liveFixture({ withFailure: false, merchantId: "close-report" });
  const finance = ctxAt(wat("2027-06-30T07:00:00"), "Finance");
  const openingUnallocated = recordsOf(state, "payments").filter((item) => item.status === "unallocated").length;
  const outstandingBefore = positionFor(state, customer.id).outstandingKobo;
  // The first close covers the seeded history too, so the seeded webhook observations and R1 allocations are in its period.
  const seededWebhook = recordsOf(state, "observations").filter((item) => item.data.source === "webhook").length;
  const seededR1 = recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.rule === "R1");
  const seededR1Kobo = seededR1.reduce((sum, item) => sum + item.amountKobo, 0);
  addObservation(state, { reference: "PSK-88213", amountKobo: due.amountKobo, source: "webhook", customerId: customer.id, dueItemId: due.id, eventId: "evt-1", occurredAt: wat("2027-06-30T06:20:00"), createdAt: wat("2027-06-30T06:20:01") });
  const first = executeAction(state, finance, { action: "daily_close" });
  const close = recordsOf(state, "closes").at(-1)!;
  assert.equal(first.record?.id, close.id);
  const report = close.data.report;
  assert.equal(close.data.period!.from, null, "the first close covers everything before it");
  assert.equal(close.data.period!.to, finance.now);
  assert.equal(report.openingUnallocated.count, openingUnallocated, "opening unallocated is the count before reconciliation ran");
  assert.equal(report.observations.bySource.webhook.received, seededWebhook + 1, "observations received by source");
  assert.equal(report.observations.bySource.webhook.paymentsResolvedTo, seededWebhook + 1, "and the Payments they resolved to");
  assert.equal(report.observations.bySource.webhook.unresolved, 0);
  assert.equal(report.allocatedByRule.R1.count, seededR1.length + 1, "allocated by rule");
  assert.equal(report.allocatedByRule.R1.kobo, seededR1Kobo + due.amountKobo);
  assert.equal(report.allocatedByRule.R1.automatic, seededR1.filter((item) => item.data.automatic === true).length + 1);
  assert.equal(typeof report.proposed.count, "number");
  assert.equal(typeof report.unallocated.olderThan24Hours, "number");
  assert.equal(typeof report.variances.count, "number");
  assert.equal(typeof report.exceptions.opened.count, "number");
  assert.equal(typeof report.exceptions.closed.count, "number");
  const changed = report.customerPositionsChanged.find((item) => item.customerId === customer.id);
  assert.ok(changed, "the customer whose position changed is listed");
  assert.equal(changed.before!.outstandingKobo, outstandingBefore);
  assert.equal(changed.after.outstandingKobo, outstandingBefore - due.amountKobo, "before and after positions");
  assert.equal(report.positionRebuild.alert, false, "REC-05: the rebuilt positions agree with the stored view");
  assert.equal(report.positionRebuild.mismatches.length, 0);
  checks += 19;

  const second = executeAction(state, ctxAt(wat("2027-07-01T07:00:00"), "Finance"), { action: "daily_close" });
  const next = recordsOf(state, "closes").at(-1)!;
  assert.notEqual(next.id, close.id);
  assert.equal(next.data.period!.from, close.data.closedAt, "the next close starts where the last one ended");
  assert.equal(next.data.report.observations.received, 0, "nothing new arrived");
  assert.equal(next.data.report.customerPositionsChanged.length, 0, "no position changed");
  assert.equal(second.data.positionAlert, false);
  const stored = structuredClone(state);
  next.data.summary = "edited";
  assert.throws(() => assertFinalState(stored, state, state.merchant.id), /immutable/, "close reports are immutable evidence");
  // A stored outstanding balance that drifts from the allocations is an alert on the next close.
  next.data.summary = stored.records.find((item) => item.id === next.id)!.data.summary;
  due.data.outstandingKobo = 100;
  executeAction(state, ctxAt(wat("2027-07-02T07:00:00"), "Finance"), { action: "daily_close" });
  const drifted = recordsOf(state, "closes").at(-1)!;
  assert.equal(drifted.data.positionAlert, true, "REC-05: a rebuild that differs from the stored view is an alert");
  assert.equal(drifted.data.report.positionRebuild.mismatches[0].dueItemId, due.id);
  assert.equal(buildReports(state, wat("2027-08-01T09:00:00")).operational.timeToClose?.month, "2027-07", "MEA-01 time to close looks at the last month end");
  checks += 9;
}

// ---------- RET-06: uplift report with the ratio-estimator interval, evaluated against the pre-registered rule ----------
function enrolledDue(state: DomainState, experiment: ValopayRecord, arm: "engine" | "holdout", amountKobo: number, firstFailureAt: string, index: number): ValopayRecord {
  const customer = recordsOf(state, "customers")[index % 8]!;
  return makeRecord(state, "due-items", { name: `enrolled ${arm} ${index}`, status: "in_collection", customerId: customer.id, amountKobo, reference: `EXP-${arm}-${index}`, data: { dueDate: firstFailureAt.slice(0, 10), owner: "valopay", outstandingKobo: amountKobo, experimentId: experiment.id, experimentArm: arm, firstFailureAt } });
}
function settle(state: DomainState, due: ValopayRecord, amountKobo: number, settledAt: string, reversed = false): void {
  const payment = makeRecord(state, "payments", { name: "settled", status: "allocated", customerId: due.customerId, amountKobo, reference: `PAY-${due.reference}`, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", settledAt, observedAt: settledAt, reversalStatus: reversed ? "reversed" : "none", refundStatus: "none", allocatedKobo: amountKobo } });
  makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: due.customerId, amountKobo, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
}
{
  const { state, policy } = liveFixture({ withFailure: false, merchantId: "uplift" });
  const experiment = makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.5, minPerArm: 3, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z", passRule: "rule" } });
  const failedAt = wat("2027-09-01T06:16:00");
  const amounts = [1_000_000, 2_000_000, 3_000_000, 4_000_000];
  const engine = amounts.map((amount, index) => enrolledDue(state, experiment, "engine", amount, failedAt, index));
  const holdout = amounts.map((amount, index) => enrolledDue(state, experiment, "holdout", amount, failedAt, index + 4));
  settle(state, engine[0]!, 1_000_000, wat("2027-09-05T10:00:00"));
  settle(state, engine[1]!, 2_000_000, wat("2027-09-20T10:00:00"));
  settle(state, engine[2]!, 1_500_000, wat("2027-09-25T10:00:00")); // partial counts by value only
  settle(state, engine[3]!, 4_000_000, wat("2027-10-15T10:00:00")); // outside the 30-day window
  settle(state, holdout[0]!, 1_000_000, wat("2027-09-10T10:00:00"));
  settle(state, holdout[1]!, 2_000_000, wat("2027-09-12T10:00:00"), true); // reversed inside the window reverses the outcome
  const immature = enrolledDue(state, experiment, "engine", 1_000_000, wat("2028-01-20T06:16:00"), 9);
  settle(state, immature, 1_000_000, wat("2028-01-21T10:00:00"));
  const report = upliftReport(state, experiment, "2028-02-01T09:00:00.000Z");
  assert.equal(report.engine.enrolled, 5); assert.equal(report.engine.mature, 4, "an item inside its 30-day window is not counted");
  assert.equal(report.holdout.mature, 4);
  assert.equal(report.engine.recoveryByValue, 0.45, "engine: 45,000 of 100,000 recovered by value");
  assert.equal(report.engine.recoveryByCount, 0.5, "two of four settled in full");
  assert.equal(report.holdout.recoveryByValue, 0.1, "holdout: the reversed payment does not count");
  assert.equal(report.holdout.recoveryByCount, 0.25);
  assert.equal(report.differenceByValue, 0.35);
  assert.equal(report.differenceByCount, 0.25);
  assert.ok(Math.abs(report.engine.varianceByValue! - 0.063667) < 1e-5, `engine ratio-estimator variance ${report.engine.varianceByValue}`);
  assert.ok(Math.abs(report.holdout.varianceByValue! - 0.014667) < 1e-5, `holdout ratio-estimator variance ${report.holdout.varianceByValue}`);
  assert.ok(Math.abs(report.confidenceInterval90!.low - -0.11037) < 1e-4, `lower bound ${report.confidenceInterval90!.low}`);
  assert.ok(Math.abs(report.confidenceInterval90!.high - 0.81037) < 1e-4, `upper bound ${report.confidenceInterval90!.high}`);
  assert.ok(Math.abs(report.confidenceInterval90ByCount!.low - -0.29402) < 1e-4, `count lower bound ${report.confidenceInterval90ByCount!.low}`);
  assert.deepEqual(report.checks, { effectAtLeastEightPoints: true, intervalExcludesZero: false, sampleMet: true, analysisDateReached: true });
  assert.equal(report.result, "not_proven", "an interval that includes zero is not proven, however large the point estimate");
  assert.match(report.reason, /interval does not exclude zero/);
  assert.equal(report.minimumPerArm, 3);
  assert.equal(report.passRule, "rule");
  checks += 19;

  // A consistent effect on the minimum sample passes, but only once the analysis date is reached.
  const { state: proven, policy: policy2 } = liveFixture({ withFailure: false, merchantId: "uplift-proven" });
  const experiment2 = makeRecord(proven, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy2.id, holdoutShare: 0.5, minPerArm: 3, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z" } });
  for (let index = 0; index < 4; index++) {
    settle(proven, enrolledDue(proven, experiment2, "engine", 2_500_000, failedAt, index), 2_500_000, wat("2027-09-05T10:00:00"));
    enrolledDue(proven, experiment2, "holdout", 2_500_000, failedAt, index + 4);
  }
  settle(proven, enrolledDue(proven, experiment2, "holdout", 2_500_000, failedAt, 8), 2_500_000, wat("2027-09-05T10:00:00"));
  const early = upliftReport(proven, experiment2, "2027-12-01T09:00:00.000Z");
  assert.equal(early.differenceByValue, 0.8);
  assert.equal(early.checks.intervalExcludesZero, true);
  assert.equal(early.checks.analysisDateReached, false);
  assert.equal(early.result, "not_proven", "no result before the pre-registered analysis date");
  const final = upliftReport(proven, experiment2, "2028-02-01T09:00:00.000Z");
  assert.equal(final.result, "proven");
  assert.ok(final.confidenceInterval90!.low > 0);
  const reports = buildReports(proven, "2028-02-01T09:00:00.000Z");
  assert.equal(reports.experiment.result, "proven");
  assert.equal(reports.experiment.results[0].experimentId, experiment2.id);
  checks += 8;
}

// ---------- BIL-01: only direct-debit attempts that succeeded are billable; transfers and card receipts are reported, never billed ----------
{
  const state = seedMerchant("billing");
  const payments = recordsOf(state, "payments");
  const ada = payments.find((item) => item.reference === "SBX-PAY-1001")!; // direct debit, allocated, settled
  const tunde = payments.find((item) => item.reference === "SBX-PAY-1002")!; // transfer, allocated, settled
  const observed = Date.parse(ada.createdAt);
  state.settings.billingPeriod = ada.createdAt.slice(0, 7);
  const afterWindow = new Date(observed + 10 * DAY).toISOString();
  const insideWindow = new Date(observed + 3 * DAY).toISOString();
  assert.equal(billableCollection(state, ada, afterWindow), true, "a settled direct debit past the reversal window is billable");
  assert.equal(billableCollection(state, tunde, afterWindow), false, "a transfer is reconciled but never billed as a collection");
  assert.equal(billableCollection(state, ada, insideWindow), false, "inside the provider's reversal window nothing is billed yet");
  state.settings.providerReversalWindowDays = { "Sandbox Rail": 2 };
  assert.equal(billableCollection(state, ada, insideWindow), true, "the provider's own reversal window applies when configured");
  delete state.settings.providerReversalWindowDays;
  const billing = buildReports(state, afterWindow).billing;
  assert.equal(billing.successfulCollections, 1, "one billable collection in the period");
  assert.equal(billing.usageFeeKobo, 7_500, "0.3% of NGN 25,000 is NGN 75, under the NGN 150 cap");
  assert.equal(billing.channelBreakdown.direct_debit.count, 2, "the proposed direct debit is counted but not billable");
  assert.equal(billing.channelBreakdown.direct_debit.billable, 1);
  assert.equal(billing.channelBreakdown.transfer.billable, 0);
  assert.equal(billing.channelBreakdown.transfer.count, 2);
  assert.deepEqual(billing.billableChannels, ["direct_debit"]);
  assert.equal(buildReports(state, insideWindow).billing.withheldInsideReversalWindow, 1, "collections inside the window are shown as withheld");
  ada.data.reversalStatus = "reversed";
  assert.equal(buildReports(state, afterWindow).billing.successfulCollections, 0, "a reversal at the invoice date removes the collection");
  checks += 13;
}

// ---------- MEA-01: packs generated and marked used are counted from the export records ----------
{
  const state = seedMerchant("packs");
  makeRecord(state, "exports", { name: "pack", status: "ready", data: { kind: "customer-pack", format: "pdf", usedInRealCase: false, checksum: "x" } });
  makeRecord(state, "exports", { name: "pack", status: "ready", data: { kind: "gate-pack", format: "pdf", usedInRealCase: false, checksum: "y" } });
  makeRecord(state, "exports", { name: "csv", status: "ready", data: { kind: "billing", format: "csv", usedInRealCase: false, checksum: "z" } });
  const operational = buildReports(state, new Date().toISOString()).operational;
  assert.equal(operational.packsGenerated, 2);
  assert.equal(operational.disputePacksGenerated, 1);
  assert.equal(operational.realCasesUsed, 0);
  checks += 3;
}

void HOUR; void addAttempt;
console.log(`Measurement golden tests passed (${checks} checks): decision records, deferral deadline, arm on decision, close report, position rebuild, uplift interval and rule, billable channels, pack counts.`);
