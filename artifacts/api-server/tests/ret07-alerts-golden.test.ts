// Golden tests for RET-07 (the consent pins the policy version; a newer version
// applies only after a notice and, where required, fresh consent) and the
// NFR-OBS-02 alerts feed.
import assert from "node:assert/strict";
import { DAY, addAttempt, addNotice, ctxAt, liveFixture, wat } from "./helpers.js";
import { executeAction } from "../src/domain/actions.js";
import { evaluateRetry, policySummary, samePolicyLineage } from "../src/domain/policy-engine.js";
import { validateRecord } from "../src/domain/validation.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { buildOverview } from "../src/domain/reports.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

let checks = 0;
const admin = (now: string) => ctxAt(now, "Admin");
const reviewer = (now: string) => ctxAt(now, "Compliance reviewer");

// ---------- RET-07: the consent record carries the version and its text; the engine keeps the consented version ----------
{
  const { state, policy, mandate, due } = liveFixture({ merchantId: "ret07" });
  // A mandate created against a policy pins the version and the policy text as it stood (MAN-02).
  const customer = recordsOf(state, "customers")[1]!;
  const input = { name: "new mandate", status: "pending_activation", customerId: customer.id, amountKobo: 5_000_000, data: { workflow: "hosted_consent", consentEvidence: "CONSENT-9", consentGaps: [], policyId: policy.id, origin: "created" } as Record<string, any>, createdAt: wat("2027-06-01T09:00:00"), updatedAt: wat("2027-06-01T09:00:00") };
  validateRecord(state, admin(wat("2027-06-01T09:00:00")), "mandates", input);
  assert.equal(input.data.consentPolicyId, policy.id);
  assert.equal(input.data.consentPolicyVersion, 1);
  assert.equal(input.data.consentPolicySummary, policySummary(policy));
  assert.match(input.data.consentPolicySummary, /Version 1: up to 3 attempts/);
  checks += 4;

  // The seeded fixture mandate predates pinning: pin it as its creation would have.
  mandate.data.consentPolicyId = policy.id; mandate.data.consentPolicyVersion = 1; mandate.data.consentPolicySummary = policySummary(policy);
  // A new version is drafted and approved by a different reviewer.
  const draft = executeAction(state, admin(wat("2027-06-02T09:00:00")), { action: "new_policy_version", recordId: policy.id, reason: "shorter spacing" }).record!;
  draft.data.spacingHours = 24;
  executeAction(state, admin(wat("2027-06-02T09:10:00")), { action: "submit_policy", recordId: draft.id, reason: "review" });
  executeAction(state, reviewer(wat("2027-06-02T09:20:00")), { action: "approve_policy", recordId: draft.id, reason: "compliant" });
  assert.equal(draft.status, "approved"); assert.equal(draft.data.version, 2);
  assert.equal(samePolicyLineage(state, policy.id, draft.id), true);
  // The engine still evaluates the consented version 1 for this mandate's due items.
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:08")).id;
  const underV1 = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy);
  assert.equal(underV1.decision, "would_schedule"); assert.equal(underV1.policyVersion, 1);
  const underV2 = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, draft);
  assert.equal(underV2.decision, "blocked"); assert.equal(underV2.rule, "policy_version_not_consented", "version 2 cannot apply before the notice");
  assert.equal(underV2.inputs.consentPolicyVersion, 1);
  checks += 8;

  // A direct edit cannot move the mandate to the new version, nor rewrite the consented version.
  const moved = { ...mandate, data: { ...mandate.data, policyId: draft.id }, updatedAt: wat("2027-06-03T09:00:00") };
  assert.throws(() => validateRecord(state, admin(wat("2027-06-03T09:00:00")), "mandates", moved, true), /apply_policy_version/);
  const rewritten = { ...mandate, data: { ...mandate.data, consentPolicyVersion: 2 }, updatedAt: wat("2027-06-03T09:00:00") };
  assert.throws(() => validateRecord(state, admin(wat("2027-06-03T09:00:00")), "mandates", rewritten, true), /server-owned/);
  checks += 2;

  // Applying the version needs a provider-accepted policy-change notice; a simulated notice is not evidence.
  const apply = (now: string, data: Record<string, unknown>) => executeAction(state, admin(now), { action: "apply_policy_version", recordId: mandate.id, reason: "customer informed", data: { policyId: draft.id, ...data } });
  assert.throws(() => apply(wat("2027-06-04T09:00:00"), {}), /provider acceptance evidence/);
  const simulated = executeAction(state, ctxAt(wat("2027-06-04T09:00:00"), "Operations"), { action: "notify_policy_change", recordId: mandate.id, reason: "inform", data: { policyId: draft.id } }).record!;
  assert.equal(simulated.data.purpose, "policy_change"); assert.equal(simulated.data.synthetic, true);
  assert.throws(() => apply(wat("2027-06-04T10:00:00"), { noticeId: simulated.id }), /provider acceptance evidence/, "a simulated notice is not evidence");
  const accepted = makeRecord(state, "notifications", { name: "policy change", status: "accepted", customerId: mandate.customerId, createdAt: wat("2027-06-05T09:00:00"), data: { purpose: "policy_change", channel: "sms", class: "required", mandateId: mandate.id, policyId: draft.id, acceptedAt: wat("2027-06-05T09:00:05"), deliveredAt: wat("2027-06-05T09:00:20") } });
  accepted.data.synthetic = false;
  state.settings.policyChangeRequiresConsent = true;
  assert.throws(() => apply(wat("2027-06-06T09:00:00"), {}), /fresh consent/, "the merchant's terms require fresh consent");
  const applied = apply(wat("2027-06-06T09:00:00"), { consentEvidence: "CONSENT-9-V2" });
  assert.equal(applied.record?.data.policyId, draft.id);
  assert.equal(mandate.data.consentPolicyId, draft.id); assert.equal(mandate.data.consentPolicyVersion, 2);
  assert.equal(mandate.data.consentEvidence, "CONSENT-9-V2");
  assert.match(mandate.data.consentPolicySummary, /Version 2: .*at least 24 hours between attempts/);
  assert.equal(mandate.data.policyVersionHistory.length, 1);
  assert.deepEqual([mandate.data.policyVersionHistory[0].fromVersion, mandate.data.policyVersionHistory[0].toVersion, mandate.data.policyVersionHistory[0].noticeId], [1, 2, accepted.id], "the history names the notice and versions");
  assert.throws(() => apply(wat("2027-06-07T09:00:00"), { consentEvidence: "again" }), /already covers/);
  // Now version 2 governs the customer's items and version 1 is refused.
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, draft).decision, "would_schedule");
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy).rule, "policy_version_not_consented");
  // Re-issue pins the fresh consent to the mandate's current version.
  mandate.status = "cancelled";
  const reissued = executeAction(state, admin(wat("2027-06-08T09:00:00")), { action: "mandate_reissue", recordId: mandate.id, reason: "new consent", data: { consentEvidence: "CONSENT-10" } }).record!;
  assert.equal(reissued.data.consentPolicyId, draft.id); assert.equal(reissued.data.consentPolicyVersion, 2);
  checks += 16;
}

// ---------- NFR-OBS-02: alerts derived from state ----------
{
  const { state, due } = liveFixture({ merchantId: "alerts", withFailure: false });
  for (const exception of recordsOf(state, "exceptions")) exception.data.dueBy = "2028-01-01T00:00:00.000Z"; // the seeded deadlines are relative to the wall clock
  const now = wat("2027-07-01T09:00:00");
  const keys = (alerts: ReturnType<typeof buildAlerts>) => alerts.map((item) => item.key);
  const quiet = buildAlerts(state, now, { valid: true, count: 1, headHash: "x" });
  assert.deepEqual(keys(quiet), ["close_overdue"], "a lender that has never closed has that one alert");
  assert.equal(quiet[0]!.severity, "medium");
  checks += 2;
  executeAction(state, ctxAt(now, "Finance"), { action: "daily_close" });
  assert.deepEqual(keys(buildAlerts(state, wat("2027-07-01T10:00:00"), { valid: true, count: 1, headHash: "x" })), [], "no alerts after a close");
  const later = wat("2027-07-03T09:00:00");
  assert.deepEqual(keys(buildAlerts(state, later)), ["close_overdue"], "the close is overdue after 36 hours");
  // Position drift, the audit chain, unallocated Payments over the threshold and a dispatched instruction in observation mode.
  due.data.outstandingKobo = 1;
  state.settings.unallocatedAlertThreshold = 0;
  const alerts = buildAlerts(state, later, { valid: false, count: 7, headHash: "y" });
  assert.deepEqual(keys(alerts), ["audit_chain_broken", "position_drift", "unallocated_over_threshold", "close_overdue"], "severity order: critical, high, medium");
  assert.equal(alerts[1]!.linkedRecordId, due.id);
  assert.match(alerts[0]!.detail, /entry 8/);
  state.merchant.mode = "observation";
  addAttempt(state, due, { status: "sent", occurredAt: wat("2027-07-02T06:16:00"), source: "valo" });
  const critical = buildAlerts(state, later);
  assert.equal(critical[0]!.key, "instruction_in_observation_mode"); assert.equal(critical[0]!.severity, "critical");
  // Notification cost per collection and overdue exceptions.
  const fresh = seedMerchant("alerts-cost");
  const month = new Date().toISOString().slice(0, 7);
  makeRecord(fresh, "notifications", { name: "sms", status: "delivered", data: { purpose: "pre_debit", channel: "sms", costKobo: 5_000, submittedAt: `${month}-02T09:00:00.000Z` } });
  const collection = recordsOf(fresh, "payments").find((item) => item.data.channel === "direct_debit")!;
  collection.data.observedAt = `${month}-03T09:00:00.000Z`;
  const costAlert = buildAlerts(fresh, `${month}-10T09:00:00.000Z`).find((item) => item.key === "notification_cost");
  assert.ok(costAlert, "NGN 50 of notification cost on one collection exceeds the NGN 8 ceiling");
  fresh.settings.notificationCostAlertKobo = 10_000;
  assert.equal(buildAlerts(fresh, `${month}-10T09:00:00.000Z`).some((item) => item.key === "notification_cost"), false, "the merchant ceiling applies");
  assert.ok(buildAlerts(fresh, new Date(Date.now() + 3 * DAY).toISOString()).some((item) => item.key === "exceptions_overdue"), "the seeded exceptions pass their deadline");
  // The overview carries the alerts and the close freezes them.
  const overview = buildOverview(state, later, critical);
  assert.equal(overview.alerts.length, critical.length);
  const closed = executeAction(state, ctxAt(later, "Finance"), { action: "daily_close" }).record!;
  assert.ok(Array.isArray(closed.data.report.alerts) && closed.data.report.alerts.some((item: any) => item.key === "instruction_in_observation_mode"), "the close report freezes the alerts at close time");
  checks += 11;
}

console.log(`RET-07 and alerts golden tests passed (${checks} checks): consent pins the version, engine refuses an unconsented version, notice and consent gates, version history, re-issue, and the alerts feed.`);
