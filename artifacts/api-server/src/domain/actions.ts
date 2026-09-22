import {
  counted, businessDateSchema,
  DEFAULT_ACTIVATION_WINDOW_DAYS, PLATFORM_OWNER, activationReminderCaps, closeRules, failureCodeList, isHandBackOwner, isKnownFailureCode,
  nextCloseInstant, normaliseFailureCode, normaliseOwner, passRuleText, resolutionCodesFor, resolveExceptionType, withinQuietHours, templateTextProblems,
  type CloseTrigger,
} from "@workspace/valopay-schema";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import { allocatePayment, applyConfirmedAllocation, reconcile, supersedeAllocation } from "./reconciliation";
import { buildReports } from "./reports";
import { buildCloseReport, closeSchedule, openingSnapshot, storedCloseCursor } from "./close";
import { issueInvoice } from "./billing";
import type { ActionInput, ActionResult, Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { assertActionRole } from "./validation";
import { countedAttempts, evaluateRetry, policyIdFor, policySummary, preregisterSample, samePolicyLineage } from "./policy-engine";
import { buildAlerts } from "./alerts";

const requiresReason = new Set([
  "kill_switch", "mandate_suspend", "mandate_cancel", "mandate_reinstate", "mandate_reissue", "activation_reminder",
  "submit_policy", "approve_policy", "reject_policy", "new_policy_version", "submit_template", "approve_template", "reject_template", "new_template_version",
  "confirm_allocation", "reject_allocation", "manual_allocate", "review_allocation", "resolve_exception", "record_refund",
  "simulate_failure", "backtest_policy", "preregister_experiment", "hand_back", "mark_pack_used", "issue_invoice", "notify_policy_change", "apply_policy_version",
]);
const DAY_MS = 24 * 60 * 60 * 1000, MINUTE_MS = 60 * 1000;

function reason(input: ActionInput): string {
  if (!input.reason?.trim()) throw new Error("Enter a reason for this action. It will be saved in the audit log.");
  return input.reason.trim();
}

function result(message: string, record?: ValopayRecord, data: Record<string, any> = {}): ActionResult {
  // The store appends the canonical transaction-sequenced audit entry and digest.
  return { message, record, data: { ...data, synthetic: true, externalInstructionPerformed: false } };
}

/** MAN-08 and DEB-06: scheduled attempts are cancelled and logged; in-flight ones complete and are recorded. */
function cancelScheduledAttempts(state: DomainState, now: string, cancellationReason: string, matches: (attempt: TypedRecord<"attempts">) => boolean): string[] {
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

/**
 * 7.5: remember the opening position, run the close, then write the REC-07
 * report as immutable evidence.  Every close, scheduled or manual, covers the
 * pending scheduled instant if one has passed and moves the schedule cursor to
 * the next configured time (REC-01); a close that starts more than
 * closeRules.lateAfterMinutes after that instant is recorded as late.
 */
export function runDailyClose(state: DomainState, ctx: Context, trigger: CloseTrigger): ActionResult {
  const now = ctx.now;
  const schedule = closeSchedule(state, now);
  const cursor = storedCloseCursor(state);
  const scheduledFor = cursor && Date.parse(cursor) <= Date.parse(now) ? cursor : null;
  const delayMinutes = scheduledFor ? Math.floor((Date.parse(now) - Date.parse(scheduledFor)) / MINUTE_MS) : null;
  const late = delayMinutes !== null && delayMinutes > closeRules.lateAfterMinutes;
  const opening = openingSnapshot(state);
  const reconciled = reconcile(state, ctx);
  const report = buildCloseReport(state, ctx, opening, reconciled.data);
  report.alerts = buildAlerts(state, now);
  const reports = buildReports(state, now);
  state.settings.nextCloseAt = nextCloseInstant(now, schedule.time);
  const summary = `${counted(report.observations.received, "observation")} received, ${counted(report.allocated.count, "allocation")} confirmed, ${report.unallocated.count} unallocated (${report.unallocated.olderThan24Hours} older than 24h), ${counted(report.exceptions.opened.count, "exception")} opened and ${report.exceptions.closed.count} closed, ${counted(report.customerPositionsChanged.length, "customer position")} changed.`;
  const close = makeRecord(state, "closes", {
    name: `Daily close ${now.slice(0, 10)}${trigger === "scheduled" ? " · scheduled" : ""}`, status: "completed", createdAt: now,
    data: {
      summary, metrics: reports.metrics, closedAt: now, period: report.period, report, operational: reports.operational, positionAlert: report.positionRebuild.alert,
      schedule: { trigger, scheduledFor, delayMinutes, late, nextAt: state.settings.nextCloseAt }, synthetic: true,
    },
  });
  const message = trigger === "scheduled"
    ? `Scheduled daily close completed${late ? ` ${delayMinutes} minutes after its ${schedule.time} WAT time` : ""}. No data was fetched from the provider or sent to the loan management system.`
    : "Daily close completed. No data was fetched from the provider or sent to the loan management system.";
  return result(message, close, { ...reconciled.data, closeId: close.id, positionAlert: report.positionRebuild.alert, schedule: close.data.schedule });
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
    if (typeof data.enabled !== "boolean") throw new Error("Choose whether the emergency stop is on or off.");
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
    return result(`${policyId ? "Policy" : "Lender"} emergency stop is ${data.enabled ? "on" : "off"}. No collection instruction was sent.`, undefined, { enabled: data.enabled, policyId, cancelledScheduledAttemptIds: cancelled });
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
    return result(`Mandate ${mandate.status}. An update for the loan management system has been recorded. No external instruction was sent.`, mandate, { cancelledScheduledAttemptIds: cancelled });
  }
  if (input.action === "mandate_reissue") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const old = findRecord(state, String(input.recordId), "mandates");
    if (!["pending_activation", "expired", "cancelled", "failed"].includes(old.status)) throw new Error("You can reissue a mandate only if it expired, was cancelled, failed or is still awaiting activation.");
    if (!data.consentEvidence || typeof data.consentEvidence !== "string") throw new Error("Enter a new consent evidence reference to reissue this mandate.");
    // RET-07: fresh consent covers the current approved version of the same policy, or the version named in data.policyId.
    const target = data.policyId ? findRecord(state, String(data.policyId), "policies") : recordsOf(state, "policies").find((item) => item.id === old.data.policyId);
    if (data.policyId && (target!.status !== "approved" || (old.data.policyId && !samePolicyLineage(state, String(old.data.policyId), target!.id)))) throw new Error("Choose an approved version of this mandate's existing policy.");
    // MAN-06: a new mandate and a new consent record; the old records are never edited.
    const fresh = makeRecord(state, "mandates", {
      name: `${old.name} · reissued`, status: "pending_activation", customerId: old.customerId, amountKobo: old.amountKobo, createdAt: now,
      data: {
        workflow: old.data.workflow, frequency: old.data.frequency, policyId: target?.id ?? old.data.policyId, origin: "reissued", reissuedFrom: old.id,
        consentPolicyId: target?.id, consentPolicyVersion: target ? Number(target.data.version || 1) : undefined, consentPolicySummary: target ? policySummary(target) : undefined,
        consentEvidence: String(data.consentEvidence), consentGaps: [], consentCapturedAt: now, consentChannel: data.consentChannel || "merchant_staff",
        activationDeadline: new Date(Date.parse(now) + DEFAULT_ACTIVATION_WINDOW_DAYS * DAY_MS).toISOString(), reminderCount: 0, reissueReason: reason(input),
      },
    });
    if (old.status === "pending_activation") { old.status = "expired"; old.data.supersededBy = fresh.id; touch(old, now); }
    return result("A new mandate and consent record have been created. No instruction was sent to the provider.", fresh, { supersededMandateId: old.id });
  }
  if (input.action === "activation_reminder") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    if (mandate.status !== "pending_activation") throw new Error("Activation reminders apply only to mandates awaiting activation.");
    const workflow = String(mandate.data.workflow) as keyof typeof activationReminderCaps;
    const cap = activationReminderCaps[workflow] ?? activationReminderCaps.hosted_consent;
    if (workflow === "hosted_consent" && mandate.data.consentGiven) throw new Error("The customer has already given consent. Activation is now with the bank, so no reminder is needed.");
    if (withinQuietHours(Date.parse(now))) throw new Error("Customer messages cannot be sent during quiet hours, from 21:00 to 08:00 WAT. Try again after 08:00.");
    const count = Number(mandate.data.reminderCount || 0);
    if (count >= cap) throw new Error(`The limit of ${cap} activation reminders has been reached for this mandate.`);
    mandate.data.reminderCount = count + 1; mandate.data.lastReminderAt = now; mandate.data.lastActionReason = reason(input); touch(mandate, now);
    const notification = makeRecord(state, "notifications", {
      name: "Activation reminder", status: "simulated", customerId: mandate.customerId, createdAt: now,
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
      if (policy.status !== "submitted" || !policy.data.author || policy.data.author === ctx.actor) throw new Error("Submit the policy for review, then ask a Compliance reviewer other than its author to approve it.");
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
      const copy = makeRecord(state, "policies", { name: policy.name, status: "draft", amountKobo: 0, createdAt: now, data: { ...carried, version: Number(policy.data.version || 0) + 1, author: ctx.actor, previousVersionId: policy.id } });
      return result("Draft policy version created.", copy);
    }
    policy.data.lastActionReason = reason(input); touch(policy, now);
    return result(`Policy ${policy.status}.`, policy);
  }
  if (["submit_template", "approve_template", "reject_template", "new_template_version"].includes(input.action)) {
    const template = findRecord(state, String(input.recordId), "templates");
    if (input.action === "new_template_version") {
      assertActionRole(ctx, ["Admin"]);
      if (template.status !== "approved") throw new Error("Create a new version from an approved template. Edit or finish reviewing an existing draft first.");
      const templates = recordsOf(state, "templates");
      const rootOf = (record: TypedRecord<"templates">): string => {
        const visited = new Set<string>();
        let current = record;
        while (current.data.previousVersionId) {
          if (visited.has(current.id)) throw new Error("Template history contains a cycle. Review its version links before creating a draft.");
          visited.add(current.id);
          const previous = templates.find(item => item.id === current.data.previousVersionId);
          if (!previous) throw new Error("The previous template version is unavailable. Restore its history before creating another version.");
          current = previous;
        }
        return current.id;
      };
      const rootId = rootOf(template);
      const family = new Set([rootId]);
      let remaining = templates.filter(item => item.id !== rootId);
      while (true) {
        const children = remaining.filter(item => family.has(String(item.data.previousVersionId || '')));
        if (!children.length) break;
        children.forEach(item => family.add(item.id));
        remaining = remaining.filter(item => !family.has(item.id));
      }
      const versions = templates.filter(item => family.has(item.id)).map(item => Number(item.data.version || 1));
      if (versions.some(version => !Number.isSafeInteger(version) || version < 1)) throw new Error("Template history has an invalid version number.");
      if (Math.max(...versions) >= Number.MAX_SAFE_INTEGER) throw new Error("This template has reached the supported version limit.");
      const { reviewer: _reviewer, approvedAt: _approved, submittedAt: _submitted, rejectedAt: _rejected, rejectionReason: _rejection, reviewHistory: _history, lastActionReason: _reason, ...carried } = template.data;
      const copy = makeRecord(state, "templates", { name: template.name, status: "draft", createdAt: now, data: { ...carried, version: Math.max(...versions) + 1, author: ctx.actor, previousVersionId: template.id, templateRootId: rootId } });
      return result("Draft template version created. The approved version is unchanged.", copy);
    }
    if (input.action === "submit_template") {
      assertActionRole(ctx, ["Admin"]);
      if (!["draft", "rejected"].includes(template.status)) throw new Error(`A ${template.status} template cannot be submitted.`);
      if (!template.data.author || template.data.author !== ctx.actor) throw new Error("Only the template author can submit it for review.");
      const problems = templateTextProblems(template.data.text);
      if (problems.length) throw new Error(problems.join(' '));
      template.status = "submitted"; template.data.submittedAt = now;
    } else {
      assertActionRole(ctx, ["Compliance reviewer"]);
      if (!template.data.author || template.data.author === ctx.actor || template.status !== "submitted") throw new Error("Submit the template for review, then ask a Compliance reviewer other than its author to approve or reject it.");
      if (input.action === "approve_template") {
        const problems = templateTextProblems(template.data.text);
        if (problems.length) throw new Error(problems.join(' '));
        template.status = "approved"; template.data.approvedAt = now;
      } else {
        template.status = "rejected"; template.data.rejectedAt = now; template.data.rejectionReason = reason(input);
      }
      template.data.reviewer = ctx.actor;
      template.data.reviewHistory = [...(Array.isArray(template.data.reviewHistory) ? template.data.reviewHistory : []), { status: template.status, reviewer: ctx.actor, at: now, reason: reason(input) }];
    }
    template.data.lastActionReason = reason(input);
    touch(template, now); return result(`Template ${template.status}.`, template);
  }
  if (input.action === "run_reconciliation") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    const reconciled = reconcile(state, ctx);
    return result(reconciled.message, undefined, reconciled.data);
  }
  if (input.action === "daily_close") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    const sourceDate = data.sourceBusinessDate === undefined ? undefined : businessDateSchema.parse(data.sourceBusinessDate);
    if (sourceDate && sourceDate > new Date(Date.parse(ctx.now) + 3600000).toISOString().slice(0, 10)) throw new Error('Choose today or an earlier source business date. Future source coverage cannot be closed.');
    const closed = runDailyClose(state, ctx, "manual");
    if (sourceDate && closed.record) closed.record.data.sourceBusinessDate = sourceDate;
    return closed;
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
    if (!allocation) throw new Error("This payment has no proposed allocation to review. Refresh the page to see its current status.");
    // The console reviews a specific proposal, not whichever proposal happens to
    // be current when its request arrives. Older API callers may omit this pair.
    if (data.proposalId !== undefined || data.proposalUpdatedAt !== undefined) {
      if (data.proposalId !== allocation.id || data.proposalUpdatedAt !== allocation.updatedAt) {
        throw Object.assign(new Error("This proposed match has changed since you opened it. Refresh the queue and review the current proposal before deciding."), { status: 409 });
      }
    }
    if (input.action === "reject_allocation") {
      allocation.status = "superseded"; allocation.data.supersededReason = reason(input);
      payment.status = "unallocated"; delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo;
    } else {
      applyConfirmedAllocation(state, ctx, allocation);
      allocation.data.confirmedBy = ctx.actor;
    }
    touch(allocation, now); touch(payment, now);
    return result(`Allocation ${input.action === "reject_allocation" ? "rejected" : "confirmed"}.`, allocation);
  }
  if (input.action === "review_allocation") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const allocation = findRecord(state, String(input.recordId), "allocations");
    if (typeof data.correct !== "boolean") throw new Error("Choose whether the allocation is correct.");
    allocation.data.reviewed = data.correct; allocation.data.reviewReason = reason(input); allocation.data.reviewedBy = ctx.actor; allocation.data.reviewedAt = now;
    if (!data.correct) supersedeAllocation(state, ctx, allocation, `Precision audit marked this allocation wrong: ${reason(input)}`);
    touch(allocation, now);
    return result(data.correct ? "Allocation reviewed as correct." : "Allocation marked incorrect and no longer applied. The payment and instalment are open for review again.", allocation);
  }
  if (input.action === "resolve_exception") {
    assertActionRole(ctx, ["Admin", "Finance", "Operations"]);
    const item = findRecord(state, String(input.recordId), "exceptions");
    if (item.data.case?.assignee && item.data.case.assignee !== ctx.actor && ctx.role !== 'Admin') throw Object.assign(new Error('Ask the case assignee or an administrator to record the resolution. Financial review remains a separate action.'), { status: 409 });
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
    if (!data.reference || /^\d{8,}$/.test(String(data.reference))) throw new Error("Enter a masked sample reference for the refund recorded outside Valo Pay.");
    const payment = findRecord(state, String(input.recordId), "payments");
    payment.data.refundStatus = "refunded"; payment.data.refundReference = String(data.reference); payment.data.refundRecordedAt = now; payment.data.refundRecordedExternally = true;
    touch(payment, now);
    return result("External refund reference recorded; Valo Pay did not move funds.", payment);
  }
  if (input.action === "simulate_failure") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const due = findRecord(state, String(input.recordId), "due-items");
    if (!data.failureCode) throw new Error("Choose a failure code.");
    if (!isKnownFailureCode(data.failureCode)) throw new Error(`Unknown failure code. Use one of: ${failureCodeList.join(", ")}.`);
    if (recordsOf(state, "attempts").some((attempt) => attempt.data.dueItemId === due.id && ["scheduled", "sent", "unknown"].includes(attempt.status))) {
      throw new Error("An earlier attempt for this instalment is still pending or has an unknown outcome. Check its status with the provider before trying again.");
    }
    const code = normaliseFailureCode(data.failureCode);
    const attempt = makeRecord(state, "attempts", {
      name: code === "TIMEOUT_UNKNOWN" ? "Simulated external attempt with unknown outcome" : "Simulated external failed attempt",
      status: code === "TIMEOUT_UNKNOWN" ? "unknown" : "failed", customerId: due.customerId, amountKobo: due.amountKobo, createdAt: now,
      data: { dueItemId: due.id, number: countedAttempts(state, due.id).length + 1, source: "external", simulated: true, failureCode: code, rawFailureCode: String(data.failureCode), occurredAt: now, actualInstruction: false },
    });
    if (due.status === "scheduled") { due.status = "in_collection"; touch(due, now); }
    return result("Sample failure recorded for a policy simulation. No debit was attempted.", attempt);
  }
  if (input.action === "backtest_policy") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance", "Compliance reviewer"]);
    const policy = findRecord(state, String(input.recordId), "policies");
    const decisions = recordsOf(state, "due-items").filter((due) => policyIdFor(state, due) === policy.id).map((due) => evaluateRetry(state, ctx, due, policy));
    return result("This simulation shows whether the policy would allow a retry and when. It does not predict how much money would be recovered.", policy, { decisions, recoveryEstimate: null, notARecoveryClaim: true });
  }
  if (input.action === "preregister_experiment") {
    assertActionRole(ctx, ["Admin"]);
    const experiment = findRecord(state, String(input.recordId), "experiments");
    if (experiment.status !== "draft") throw new Error("This experiment plan has already been registered and cannot be changed.");
    const policy = recordsOf(state, "policies").find((item) => item.id === experiment.data.policyId && item.status === "approved");
    if (!policy) throw new Error("Choose an approved policy before registering the experiment plan.");
    const analysis = Date.parse(experiment.data.analysisDate), close = Date.parse(experiment.data.enrolmentClose);
    if (!Number.isFinite(analysis) || !Number.isFinite(close) || close > analysis - 30 * DAY_MS || close <= Date.parse(now)) throw new Error("Enrolment must close in the future and at least 30 days before analysis.");
    const sample = preregisterSample(Number(experiment.data.baselineRate), Number(experiment.data.holdoutShare));
    experiment.data.sampleCalculation = sample;
    experiment.data.minPerArm = Math.max(Number(experiment.data.minPerArm || 0), sample.holdoutMinimum);
    experiment.data.passRule = passRuleText;
    experiment.status = "preregistered"; experiment.data.preregisteredAt = now; experiment.data.parametersFrozen = true; experiment.data.preregisteredBy = ctx.actor;
    touch(experiment, now);
    return result("Experiment plan registered and locked. Instalments will be assigned to a group at their first eligible future failure, not when the plan is registered.", experiment, { assigned: 0 });
  }
  if (input.action === "hand_back") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    // DEB-12: ownership reverts to the owner named in the cutover contract; every future instruction is cancelled.
    const contract = recordsOf(state, "cutovers").filter((item) => item.status !== "handed_back").at(-1);
    const contractOwner = normaliseOwner(contract?.data.fallbackOwner);
    const fallbackOwner = isHandBackOwner(contractOwner) ? contractOwner : "lms";
    const reverted = recordsOf(state, "due-items").filter((item) => item.data.owner === PLATFORM_OWNER).map((item) => { item.data.owner = fallbackOwner; item.data.handBackAt = now; touch(item, now); return item.id; });
    const cancelled = cancelScheduledAttempts(state, now, "Hand-back: no future instruction is held.", () => true);
    state.merchant.killSwitch = true;
    const checklist = [`Ownership of ${reverted.length} obligations reverted to ${fallbackOwner}`, `${cancelled.length} scheduled attempts cancelled with notices`, "Incumbent schedules re-enabled by the merchant against this checklist", "Full export delivered", "No future instructions are held for this merchant"];
    const cutover = makeRecord(state, "cutovers", { name: "Hand-back", status: "handed_back", createdAt: now, data: { checklist, fallbackOwner, confirmation: reason(input), revertedDueItemIds: reverted, cancelledAttemptIds: cancelled, handedBackAt: now } });
    return result("Collection ownership returned to the configured fallback owner. Scheduled attempts were cancelled and no future instructions remain queued.", cutover, { fallbackOwner, reverted: reverted.length, cancelled: cancelled.length });
  }
  if (input.action === "notify_policy_change") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const target = findRecord(state, String(data.policyId), "policies");
    if (target.status !== "approved" || (mandate.data.policyId && !samePolicyLineage(state, String(mandate.data.policyId), target.id))) throw new Error("Choose an approved version of this mandate's existing policy.");
    if (withinQuietHours(Date.parse(now))) throw new Error("Customer messages cannot be sent during quiet hours, from 21:00 to 08:00 WAT. Try again after 08:00.");
    const notification = makeRecord(state, "notifications", {
      name: "Policy change notice", status: "simulated", customerId: mandate.customerId, createdAt: now,
      data: { purpose: "policy_change", channel: "sms", class: "required", mandateId: mandate.id, policyId: target.id, policyVersion: Number(target.data.version || 1), submittedAt: now, acceptedAt: null, deliveredAt: null, renderedText: `${state.merchant.name}: the retry rules on your mandate change to ${policySummary(target)} Contact: ${state.settings.contactRoute || "your lender"}.`, simulated: true },
    });
    return result("Policy-change notice recorded as a simulation; it is not provider-accepted evidence and no message left the platform.", notification, { notificationId: notification.id, policyId: target.id });
  }
  if (input.action === "apply_policy_version") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const target = findRecord(state, String(data.policyId), "policies");
    if (target.status !== "approved" || !target.data.reviewer) throw new Error("Only an approved policy version can be applied.");
    if (mandate.data.policyId && !samePolicyLineage(state, String(mandate.data.policyId), target.id)) throw new Error("The version must belong to the mandate's policy; a different policy needs a re-issued mandate.");
    if (mandate.data.consentPolicyId === target.id) throw new Error("The consent already covers this version.");
    // RET-07: a notice accepted by the provider, and fresh consent where the merchant's terms require it.
    const notice = recordsOf(state, "notifications").find((item) => (data.noticeId ? item.id === data.noticeId : item.data.mandateId === mandate.id && item.data.policyId === target.id) && item.data.purpose === "policy_change" && item.data.acceptedAt && item.data.synthetic !== true);
    if (!notice) throw new Error("Before applying a new version, record evidence that the provider accepted the policy-change notice. A simulated notice does not count.");
    const consentRequired = state.settings.policyChangeRequiresConsent === true;
    if (consentRequired && (!data.consentEvidence || typeof data.consentEvidence !== "string")) throw new Error("This lender's terms require new consent for a policy change. Enter the new consent evidence reference.");
    const history = Array.isArray(mandate.data.policyVersionHistory) ? mandate.data.policyVersionHistory : [];
    history.push({ fromPolicyId: mandate.data.consentPolicyId ?? null, fromVersion: mandate.data.consentPolicyVersion ?? null, toPolicyId: target.id, toVersion: Number(target.data.version || 1), noticeId: notice.id, consentEvidence: consentRequired ? String(data.consentEvidence) : null, appliedAt: now, actor: ctx.actor, reason: reason(input) });
    mandate.data.policyVersionHistory = history;
    mandate.data.policyId = target.id;
    mandate.data.consentPolicyId = target.id;
    mandate.data.consentPolicyVersion = Number(target.data.version || 1);
    mandate.data.consentPolicySummary = policySummary(target);
    if (consentRequired) { mandate.data.consentEvidence = String(data.consentEvidence); mandate.data.consentCapturedAt = now; }
    touch(mandate, now);
    return result(`Policy version ${target.data.version ?? 1} now applies to this mandate after the notice${consentRequired ? " and fresh consent" : ""}; the previous version stays on record.`, mandate, { policyId: target.id, noticeId: notice.id });
  }
  if (input.action === "issue_invoice") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const invoice = issueInvoice(state, ctx, { period: data.period });
    invoice.data.issueReason = reason(input);
    return result(`Invoice ${invoice.reference} issued for ${invoice.data.period}: ${invoice.data.collectionsCounted} collections counted, ${invoice.data.adjustments.length} adjustment lines. Issued invoices cannot be changed. Corrections appear on the next invoice.`, invoice, { invoiceId: invoice.id, period: invoice.data.period, totals: invoice.data.totals });
  }
  if (input.action === "mark_pack_used") throw new Error("Synthetic exports can never be counted as real cases.");
  throw new Error(`Unsupported domain action: ${input.action}.`);
}
