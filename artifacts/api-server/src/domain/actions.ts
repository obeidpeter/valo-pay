import {
  DEFAULT_ACTIVATION_WINDOW_DAYS, PLATFORM_OWNER, activationReminderCaps, failureCodeList, isKnownFailureCode,
  normaliseFailureCode, normaliseOwner, passRuleText, resolutionCodesFor, resolveExceptionType, withinQuietHours,
} from "@workspace/valopay-schema";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import { allocatePayment, applyConfirmedAllocation, reconcile, supersedeAllocation } from "./reconciliation";
import { buildReports } from "./reports";
import { buildCloseReport, openingSnapshot } from "./close";
import type { ActionInput, ActionResult, Context, DomainState, ValopayRecord } from "./types";
import { assertActionRole } from "./validation";
import { countedAttempts, evaluateRetry, policyIdFor, preregisterSample } from "./policy-engine";

const requiresReason = new Set([
  "kill_switch", "mandate_suspend", "mandate_cancel", "mandate_reinstate", "mandate_reissue", "activation_reminder",
  "submit_policy", "approve_policy", "reject_policy", "new_policy_version", "submit_template", "approve_template",
  "confirm_allocation", "reject_allocation", "manual_allocate", "review_allocation", "resolve_exception", "record_refund",
  "simulate_failure", "backtest_policy", "preregister_experiment", "hand_back", "mark_pack_used",
]);
const DAY_MS = 24 * 60 * 60 * 1000;

function reason(input: ActionInput): string {
  if (!input.reason?.trim()) throw new Error("A reason is required for this business or destructive action.");
  return input.reason.trim();
}

function result(message: string, record?: ValopayRecord, data: Record<string, any> = {}): ActionResult {
  // The store appends the canonical transaction-sequenced audit entry and digest.
  return { message, record, data: { ...data, synthetic: true, externalInstructionPerformed: false } };
}

/** MAN-08 and DEB-06: scheduled attempts are cancelled and logged; in-flight ones complete and are recorded. */
function cancelScheduledAttempts(state: DomainState, now: string, cancellationReason: string, matches: (attempt: ValopayRecord) => boolean): string[] {
  return recordsOf(state, "attempts").filter((attempt) => attempt.status === "scheduled" && matches(attempt)).map((attempt) => {
    attempt.status = "cancelled";
    attempt.data.cancellationReason = cancellationReason;
    touch(attempt, now);
    return attempt.id;
  });
}

function dueItemsUnderMandate(state: DomainState, mandateId: string): Set<string> {
  return new Set(recordsOf(state, "due-items").filter((due) => due.data.mandateId === mandateId).map((due) => due.id));
}

export function executeAction(state: DomainState, ctx: Context, input: ActionInput): ActionResult {
  if (!input.action) throw new Error("action is required.");
  if (requiresReason.has(input.action)) reason(input);
  const data = input.data || {};
  const now = ctx.now;
  if (input.action === "request_instruction") throw new Error("Blocked: this synthetic observation sandbox can never send a provider or bank instruction.");
  if (input.action === "set_role" || input.action === "verify_audit" || input.action === "create_export") throw new Error(`${input.action} is handled by the API shell, not the domain action engine.`);

  if (input.action === "kill_switch") {
    assertActionRole(ctx, ["Admin"]);
    if (typeof data.enabled !== "boolean") throw new Error("data.enabled must be boolean.");
    let policyId: string | undefined;
    if (data.policyId) {
      // Approved policy versions are immutable, so the switch lives in merchant settings (DEB-06).
      policyId = findRecord(state, String(data.policyId), "policies").id;
      state.settings.policyKillSwitches = { ...(state.settings.policyKillSwitches || {}), [policyId]: data.enabled };
    } else {
      state.merchant.killSwitch = data.enabled;
    }
    const cancelled = data.enabled
      ? cancelScheduledAttempts(state, now, policyId ? "Policy version kill switch" : "Merchant kill switch", (attempt) => !policyId || policyIdFor(state, findRecord(state, String(attempt.data.dueItemId), "due-items")) === policyId)
      : [];
    return result(`${policyId ? "Policy version" : "Merchant"} kill switch ${data.enabled ? "enabled" : "released"}; no instruction was sent.`, undefined, { enabled: data.enabled, policyId, cancelledScheduledAttemptIds: cancelled });
  }
  if (["mandate_suspend", "mandate_cancel", "mandate_reinstate"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const dues = dueItemsUnderMandate(state, mandate.id);
    if (input.action === "mandate_suspend") {
      if (mandate.status !== "active") throw new Error("Only an active mandate can be suspended.");
      mandate.status = "suspended"; mandate.data.suspendedAt = now;
    }
    if (input.action === "mandate_cancel") {
      if (!["draft", "submitted", "pending_activation", "active", "suspended"].includes(mandate.status)) throw new Error(`A ${mandate.status} mandate cannot be cancelled.`);
      mandate.status = "cancelled"; mandate.data.cancelledAt = now;
    }
    if (input.action === "mandate_reinstate") {
      if (mandate.status !== "suspended") throw new Error("Only a suspended mandate can be reinstated.");
      mandate.status = "active"; mandate.data.reinstatedAt = now;
    }
    const cancelled = input.action === "mandate_reinstate" ? [] : cancelScheduledAttempts(state, now, `Mandate ${mandate.status}; no instruction was sent.`, (attempt) => dues.has(String(attempt.data.dueItemId)));
    mandate.data.lastActionReason = reason(input); touch(mandate, now);
    return result(`Mandate ${mandate.status}; the LMS outcome event is recorded for delivery. No external instruction was sent.`, mandate, { cancelledScheduledAttemptIds: cancelled });
  }
  if (input.action === "mandate_reissue") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const old = findRecord(state, String(input.recordId), "mandates");
    if (!["pending_activation", "expired", "cancelled", "failed"].includes(old.status)) throw new Error("Re-issue applies to mandates that expired, were cancelled, failed or never activated.");
    if (!data.consentEvidence || typeof data.consentEvidence !== "string") throw new Error("A re-issue needs a new consent record: supply data.consentEvidence.");
    // MAN-06: a new mandate and a new consent record; the old records are never edited.
    const fresh = makeRecord(state, "mandates", {
      name: `${old.name} · reissued`, status: "pending_activation", customerId: old.customerId, amountKobo: old.amountKobo,
      data: {
        workflow: old.data.workflow, frequency: old.data.frequency, policyId: old.data.policyId, origin: "reissued", reissuedFrom: old.id,
        consentEvidence: String(data.consentEvidence), consentGaps: [], consentCapturedAt: now, consentChannel: data.consentChannel || "merchant_staff",
        activationDeadline: new Date(Date.parse(now) + DEFAULT_ACTIVATION_WINDOW_DAYS * DAY_MS).toISOString(), reminderCount: 0, reissueReason: reason(input),
      },
    });
    if (old.status === "pending_activation") { old.status = "expired"; old.data.supersededBy = fresh.id; touch(old, now); }
    return result("Re-issued as a new mandate with a new consent record; no provider instruction was sent.", fresh, { supersededMandateId: old.id });
  }
  if (input.action === "activation_reminder") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    if (mandate.status !== "pending_activation") throw new Error("Activation reminders apply only to mandates awaiting activation.");
    const workflow = String(mandate.data.workflow) as keyof typeof activationReminderCaps;
    const cap = activationReminderCaps[workflow] ?? activationReminderCaps.hosted_consent;
    if (workflow === "hosted_consent" && mandate.data.consentGiven) throw new Error("Consent is already given; activation is in the bank's hands and no reminder is sent.");
    if (withinQuietHours(Date.parse(now))) throw new Error("Quiet hours 21:00–08:00 WAT: the messaging adapter refuses customer messages.");
    const count = Number(mandate.data.reminderCount || 0);
    if (count >= cap) throw new Error(`Reminder cap of ${cap} reached for the ${workflow} workflow.`);
    mandate.data.reminderCount = count + 1; mandate.data.lastReminderAt = now; mandate.data.lastActionReason = reason(input); touch(mandate, now);
    const notification = makeRecord(state, "notifications", {
      name: "Activation reminder", status: "simulated", customerId: mandate.customerId,
      data: { purpose: "activation_reminder", channel: "sms", class: "reminder", mandateId: mandate.id, sequence: count + 1, cap, submittedAt: now, acceptedAt: null, deliveredAt: null, renderedText: `Reminder ${count + 1} of ${cap} to complete ${workflow === "hosted_consent" ? "the consent link" : "the activation transfer"}.`, simulated: true },
    });
    return result(`Activation reminder ${count + 1} of ${cap} recorded as a simulation; no message left the platform.`, mandate, { notificationId: notification.id });
  }
  if (["submit_policy", "approve_policy", "reject_policy", "new_policy_version"].includes(input.action)) {
    const policy = findRecord(state, String(input.recordId), "policies");
    if (input.action === "submit_policy") {
      assertActionRole(ctx, ["Admin"]);
      if (!["draft", "rejected"].includes(policy.status)) throw new Error(`A ${policy.status} policy cannot be submitted.`);
      policy.status = "submitted"; policy.data.author = ctx.actor; policy.data.submittedAt = now;
    }
    if (input.action === "approve_policy") {
      assertActionRole(ctx, ["Compliance reviewer"]);
      if (policy.status !== "submitted" || !policy.data.author || policy.data.author === ctx.actor) throw new Error("A different Compliance reviewer may approve a submitted policy only.");
      policy.status = "approved"; policy.data.reviewer = ctx.actor; policy.data.approvedAt = now;
    }
    if (input.action === "reject_policy") {
      assertActionRole(ctx, ["Compliance reviewer"]);
      if (policy.status !== "submitted") throw new Error("Only a submitted policy can be rejected.");
      policy.status = "rejected"; policy.data.reviewer = ctx.actor; policy.data.rejectedAt = now;
    }
    if (input.action === "new_policy_version") {
      assertActionRole(ctx, ["Admin"]);
      const { reviewer: _reviewer, approvedAt: _approvedAt, submittedAt: _submittedAt, rejectedAt: _rejectedAt, ...carried } = policy.data;
      const copy = makeRecord(state, "policies", { name: policy.name, status: "draft", amountKobo: 0, data: { ...carried, version: Number(policy.data.version || 0) + 1, author: ctx.actor, previousVersionId: policy.id } });
      return result("Draft policy version created.", copy);
    }
    policy.data.lastActionReason = reason(input); touch(policy, now);
    return result(`Policy ${policy.status}.`, policy);
  }
  if (["submit_template", "approve_template"].includes(input.action)) {
    const template = findRecord(state, String(input.recordId), "templates");
    if (input.action === "submit_template") {
      assertActionRole(ctx, ["Admin"]);
      if (!["draft", "rejected"].includes(template.status)) throw new Error(`A ${template.status} template cannot be submitted.`);
      template.status = "submitted"; template.data.author = ctx.actor;
    } else {
      assertActionRole(ctx, ["Compliance reviewer"]);
      if (template.data.author === ctx.actor || template.status !== "submitted") throw new Error("A different Compliance reviewer must approve a submitted template.");
      template.status = "approved"; template.data.reviewer = ctx.actor; template.data.approvedAt = now;
    }
    touch(template, now); return result(`Template ${template.status}.`, template);
  }
  if (input.action === "run_reconciliation") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    const reconciled = reconcile(state, ctx);
    return result(reconciled.message, undefined, reconciled.data);
  }
  if (input.action === "daily_close") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    // 7.5: remember the opening position, run the close, then write the REC-07 report as immutable evidence.
    const opening = openingSnapshot(state);
    const reconciled = reconcile(state, ctx);
    const report = buildCloseReport(state, ctx, opening, reconciled.data);
    const reports = buildReports(state, now);
    const summary = `${report.observations.received} observations received, ${report.allocated.count} allocations confirmed, ${report.unallocated.count} unallocated (${report.unallocated.olderThan24Hours} older than 24h), ${report.exceptions.opened.count} exceptions opened and ${report.exceptions.closed.count} closed, ${report.customerPositionsChanged.length} customer positions changed.`;
    const close = makeRecord(state, "closes", {
      name: `Daily close ${now.slice(0, 10)}`, status: "completed",
      data: { summary, metrics: reports.metrics, closedAt: now, period: report.period, report, operational: reports.operational, positionAlert: report.positionRebuild.alert, synthetic: true },
    });
    return result("Daily close completed; no provider pull or LMS push occurred.", close, { ...reconciled.data, closeId: close.id, positionAlert: report.positionRebuild.alert });
  }
  if (["confirm_allocation", "reject_allocation", "manual_allocate"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const payment = findRecord(state, String(input.recordId), "payments");
    if (input.action === "manual_allocate") {
      const due = findRecord(state, String(data.dueItemId), "due-items");
      const allocation = allocatePayment(state, ctx, payment, due, Number(data.amountKobo), "R7", "manual", false, `Finance allocated manually: ${reason(input)}`);
      return result("Manual allocation recorded by Finance.", allocation);
    }
    const allocation = recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id && item.status === "proposed");
    if (!allocation) throw new Error("No proposed allocation exists for this payment.");
    if (input.action === "reject_allocation") {
      allocation.status = "superseded"; allocation.data.supersededReason = reason(input);
      payment.status = "unallocated"; delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo;
    } else {
      allocation.data.confirmedBy = ctx.actor;
      applyConfirmedAllocation(state, ctx, allocation);
    }
    touch(allocation, now); touch(payment, now);
    return result(`Allocation ${input.action === "reject_allocation" ? "rejected" : "confirmed"}.`, allocation);
  }
  if (input.action === "review_allocation") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const allocation = findRecord(state, String(input.recordId), "allocations");
    if (typeof data.correct !== "boolean") throw new Error("data.correct must be boolean.");
    allocation.data.reviewed = data.correct; allocation.data.reviewReason = reason(input); allocation.data.reviewedBy = ctx.actor; allocation.data.reviewedAt = now;
    if (!data.correct) supersedeAllocation(state, ctx, allocation, `Precision audit marked this allocation wrong: ${reason(input)}`);
    touch(allocation, now);
    return result(data.correct ? "Allocation reviewed as correct." : "Allocation reviewed as wrong and superseded; the payment and due item are reopened.", allocation);
  }
  if (input.action === "resolve_exception") {
    assertActionRole(ctx, ["Admin", "Finance", "Operations"]);
    const item = findRecord(state, String(input.recordId), "exceptions");
    if (["resolved", "closed"].includes(item.status)) throw new Error("This exception is already resolved.");
    const allowed = resolutionCodesFor(item.data.type);
    if (!allowed.includes(String(data.resolutionCode))) throw new Error(`Resolution code must be one of: ${allowed.join(", ")}.`);
    item.status = "resolved"; item.data.resolutionCode = data.resolutionCode; item.data.notes = reason(input); item.data.resolvedBy = ctx.actor; item.data.resolvedAt = now;
    if (!resolveExceptionType(item.data.type)) item.data.legacyType = true;
    touch(item, now);
    return result("Exception resolution recorded.", item);
  }
  if (input.action === "record_refund") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    if (!data.reference || /^\d{8,}$/.test(String(data.reference))) throw new Error("A masked synthetic external refund reference is required.");
    const payment = findRecord(state, String(input.recordId), "payments");
    payment.data.refundStatus = "refunded"; payment.data.refundReference = String(data.reference); payment.data.refundRecordedAt = now; payment.data.refundRecordedExternally = true;
    touch(payment, now);
    return result("External refund reference recorded; Valo Pay did not move funds.", payment);
  }
  if (input.action === "simulate_failure") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const due = findRecord(state, String(input.recordId), "due-items");
    if (!data.failureCode) throw new Error("data.failureCode is required.");
    if (!isKnownFailureCode(data.failureCode)) throw new Error(`Unknown failure code. Use one of: ${failureCodeList.join(", ")}.`);
    if (recordsOf(state, "attempts").some((attempt) => attempt.data.dueItemId === due.id && ["scheduled", "sent", "unknown"].includes(attempt.status))) {
      throw new Error("An in-flight or unknown attempt already exists for this due item; resolve it by status query first.");
    }
    const code = normaliseFailureCode(data.failureCode);
    const attempt = makeRecord(state, "attempts", {
      name: code === "TIMEOUT_UNKNOWN" ? "Simulated external attempt with unknown outcome" : "Simulated external failed attempt",
      status: code === "TIMEOUT_UNKNOWN" ? "unknown" : "failed", customerId: due.customerId, amountKobo: due.amountKobo,
      data: { dueItemId: due.id, number: countedAttempts(state, due.id).length + 1, source: "external", simulated: true, failureCode: code, rawFailureCode: String(data.failureCode), occurredAt: now, actualInstruction: false },
    });
    if (due.status === "scheduled") { due.status = "in_collection"; touch(due, now); }
    return result("Synthetic failure recorded for policy backtest only; no debit was attempted.", attempt);
  }
  if (input.action === "backtest_policy") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance", "Compliance reviewer"]);
    const policy = findRecord(state, String(input.recordId), "policies");
    const decisions = recordsOf(state, "due-items").filter((due) => policyIdFor(state, due) === policy.id).map((due) => evaluateRetry(state, ctx, due, policy));
    return result("Backtest shows scheduling constraints only and makes no recovery claim.", policy, { decisions, recoveryEstimate: null, notARecoveryClaim: true });
  }
  if (input.action === "preregister_experiment") {
    assertActionRole(ctx, ["Admin"]);
    const experiment = findRecord(state, String(input.recordId), "experiments");
    if (experiment.status !== "draft") throw new Error("Experiment parameters are already frozen.");
    const policy = recordsOf(state, "policies").find((item) => item.id === experiment.data.policyId && item.status === "approved");
    if (!policy) throw new Error("A preregistered experiment requires an approved policy.");
    const analysis = Date.parse(experiment.data.analysisDate), close = Date.parse(experiment.data.enrolmentClose);
    if (!Number.isFinite(analysis) || !Number.isFinite(close) || close > analysis - 30 * DAY_MS || close <= Date.parse(now)) throw new Error("Enrolment must close in the future and at least 30 days before analysis.");
    experiment.data.sampleCalculation = preregisterSample(Number(experiment.data.baselineRate), Number(experiment.data.holdoutShare));
    experiment.data.minPerArm = Math.max(Number(experiment.data.minPerArm || 0), experiment.data.sampleCalculation.holdoutMinimum);
    experiment.data.passRule = passRuleText;
    experiment.status = "preregistered"; experiment.data.preregisteredAt = now; experiment.data.parametersFrozen = true; experiment.data.preregisteredBy = ctx.actor;
    touch(experiment, now);
    return result("Parameters frozen. Assignment occurs once at the first eligible future retryable failure, never at preregistration.", experiment, { assigned: 0 });
  }
  if (input.action === "hand_back") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    // DEB-12: ownership reverts to the owner named in the cutover contract; every future instruction is cancelled.
    const contract = recordsOf(state, "cutovers").filter((item) => item.status !== "handed_back").at(-1);
    const fallbackOwner = normaliseOwner(contract?.data.fallbackOwner) ?? "lms";
    const reverted = recordsOf(state, "due-items").filter((item) => item.data.owner === PLATFORM_OWNER).map((item) => { item.data.owner = fallbackOwner === PLATFORM_OWNER ? "lms" : fallbackOwner; item.data.handBackAt = now; touch(item, now); return item.id; });
    const cancelled = cancelScheduledAttempts(state, now, "Hand-back: no future instruction is held.", () => true);
    state.merchant.killSwitch = true;
    const checklist = [`Ownership of ${reverted.length} obligations reverted to ${fallbackOwner}`, `${cancelled.length} scheduled attempts cancelled with notices`, "Incumbent schedules re-enabled by the merchant against this checklist", "Full export delivered", "No future instructions are held for this merchant"];
    const cutover = makeRecord(state, "cutovers", { name: "Hand-back", status: "handed_back", data: { checklist, fallbackOwner, confirmation: reason(input), revertedDueItemIds: reverted, cancelledAttemptIds: cancelled, handedBackAt: now } });
    return result("Hand-back completed: ownership reverted, scheduled attempts cancelled, no future instructions held.", cutover, { fallbackOwner, reverted: reverted.length, cancelled: cancelled.length });
  }
  if (input.action === "mark_pack_used") throw new Error("Synthetic exports can never be counted as real cases.");
  throw new Error(`Unsupported domain action: ${input.action}.`);
}
