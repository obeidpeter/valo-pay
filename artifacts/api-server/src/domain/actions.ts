import { createHash } from "node:crypto";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import { allocatePayment, applyConfirmedAllocation, reconcile } from "./reconciliation";
import { buildReports } from "./reports";
import type { ActionInput, ActionResult, Context, DomainState, ValopayRecord } from "./types";
import { assertActionRole } from "./validation";
import { evaluateRetry, policyIdFor, preregisterSample } from "./policy-engine";

const requiresReason = new Set(["kill_switch", "mandate_suspend", "mandate_cancel", "mandate_reissue", "activation_reminder", "submit_policy", "approve_policy", "reject_policy", "new_policy_version", "submit_template", "approve_template", "confirm_allocation", "reject_allocation", "manual_allocate", "review_allocation", "resolve_exception", "record_refund", "simulate_failure", "backtest_policy", "preregister_experiment", "hand_back", "mark_pack_used"]);

function reason(input: ActionInput): string {
  if (!input.reason?.trim()) throw new Error("A reason is required for this business or destructive action.");
  return input.reason.trim();
}

function result(state: DomainState, ctx: Context, input: ActionInput, message: string, record?: ValopayRecord, data: Record<string, any> = {}): ActionResult {
  // The store appends the canonical transaction-sequenced audit entry and digest.
  void state; void ctx; void input; void record;
  return { message, record, data: { ...data, synthetic: true, externalInstructionPerformed: false } };
}

function policyFor(state: DomainState, due: ValopayRecord): ValopayRecord | undefined {
  return due.data.policyId ? recordsOf(state, "policies").find((item) => item.id === due.data.policyId && item.status === "approved") : undefined;
}

function stableArm(seed: string, key: string, holdout: number): "engine" | "holdout" {
  const value = parseInt(createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
  return value < holdout ? "holdout" : "engine";
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
      const policy = findRecord(state, String(data.policyId), "policies");
      policy.data.killSwitch = data.enabled;
      touch(policy, now);
      policyId = policy.id;
    } else {
      state.merchant.killSwitch = data.enabled;
    }
    const cancelled = data.enabled ? recordsOf(state, "attempts").filter((item) =>
      item.status === "scheduled" && (!policyId || findRecord(state, String(item.data.dueItemId), "due-items").data.policyId === policyId),
    ).map((item) => {
      item.status = "cancelled";
      item.data.cancellationReason = policyId ? "Synthetic policy kill switch" : "Synthetic merchant kill switch";
      touch(item, now);
      return item.id;
    }) : [];
    return result(state, ctx, input, `Synthetic ${policyId ? "policy" : "merchant"} kill switch ${data.enabled ? "enabled" : "released"}; no instruction was sent.`, undefined, { enabled: data.enabled, policyId, cancelledScheduledAttemptIds: cancelled });
  }
  if (["mandate_suspend", "mandate_cancel", "mandate_reissue", "activation_reminder"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const mandate = findRecord(state, String(input.recordId), "mandates");
    if (input.action === "mandate_suspend") mandate.status = "suspended";
    if (input.action === "mandate_cancel") mandate.status = "cancelled";
    if (input.action === "mandate_reissue") { mandate.status = "pending_activation"; mandate.data.reissuedAt = now; }
    if (input.action === "activation_reminder") {
      const count = Number(mandate.data.reminderCount || 0);
      if (count >= 3) throw new Error("Synthetic activation reminder cap reached.");
      mandate.data.reminderCount = count + 1; mandate.data.lastReminderAt = now;
    }
    mandate.data.lastActionReason = reason(input); touch(mandate, now);
    return result(state, ctx, input, "Mandate workflow recorded as a simulation; no external message or instruction was sent.", mandate);
  }
  if (["submit_policy", "approve_policy", "reject_policy", "new_policy_version"].includes(input.action)) {
    const policy = findRecord(state, String(input.recordId), "policies");
    if (input.action === "submit_policy") { assertActionRole(ctx, ["Admin"]); policy.status = "submitted"; policy.data.author = ctx.actor; }
    if (input.action === "approve_policy") {
      assertActionRole(ctx, ["Compliance reviewer"]);
      if (policy.status !== "submitted" || !policy.data.author || policy.data.author === ctx.actor) throw new Error("A different Compliance reviewer may approve a submitted policy only.");
      policy.status = "approved"; policy.data.reviewer = ctx.actor; policy.data.approvedAt = now;
    }
    if (input.action === "reject_policy") { assertActionRole(ctx, ["Compliance reviewer"]); policy.status = "rejected"; policy.data.reviewer = ctx.actor; }
    if (input.action === "new_policy_version") {
      assertActionRole(ctx, ["Admin"]);
      const copy = makeRecord(state, "policies", { name: policy.name, status: "draft", amountKobo: 0, data: { ...policy.data, version: Number(policy.data.version || 0) + 1, author: ctx.actor, reviewer: undefined, approvedAt: undefined } });
      return result(state, ctx, input, "Draft policy version created.", copy);
    }
    touch(policy, now); return result(state, ctx, input, `Policy ${policy.status}.`, policy);
  }
  if (["submit_template", "approve_template"].includes(input.action)) {
    const template = findRecord(state, String(input.recordId), "templates");
    if (input.action === "submit_template") { assertActionRole(ctx, ["Admin"]); template.status = "submitted"; template.data.author = ctx.actor; }
    else { assertActionRole(ctx, ["Compliance reviewer"]); if (template.data.author === ctx.actor || template.status !== "submitted") throw new Error("A different Compliance reviewer must approve a submitted template."); template.status = "approved"; template.data.reviewer = ctx.actor; }
    touch(template, now); return result(state, ctx, input, `Template ${template.status}.`, template);
  }
  if (input.action === "run_reconciliation") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    const reconciled = reconcile(state, ctx);
    return result(state, ctx, input, reconciled.message, undefined, reconciled.data);
  }
  if (input.action === "daily_close") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"]);
    const reconciled = reconcile(state, ctx);
    const close = makeRecord(state, "closes", { name: "Synthetic daily close", status: "completed", data: { summary: reconciled.message, metrics: buildReports(state, now).metrics, closedAt: now, synthetic: true } });
    return result(state, ctx, input, "Synthetic daily close completed; no provider pull or LMS push occurred.", close, reconciled.data);
  }
  if (["confirm_allocation", "reject_allocation", "manual_allocate"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const payment = findRecord(state, String(input.recordId), "payments");
    if (input.action === "manual_allocate") {
      const due = findRecord(state, String(data.dueItemId), "due-items");
      const allocation = allocatePayment(state, ctx, payment, due, Number(data.amountKobo), "R7", "manual", false);
      return result(state, ctx, input, "Manual allocation recorded by Finance.", allocation);
    }
    const allocation = recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id && item.status === "proposed");
    if (!allocation) throw new Error("No proposed allocation exists for this payment.");
    if (input.action === "reject_allocation") { allocation.status = "superseded"; payment.status = "unallocated"; }
    else applyConfirmedAllocation(state, ctx, allocation);
    touch(allocation, now); touch(payment, now);
    return result(state, ctx, input, `Allocation ${input.action === "reject_allocation" ? "rejected" : "confirmed"}.`, allocation);
  }
  if (input.action === "review_allocation") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    const allocation = findRecord(state, String(input.recordId), "allocations");
    if (typeof data.correct !== "boolean") throw new Error("data.correct must be boolean.");
    allocation.data.reviewed = data.correct; allocation.data.reviewReason = reason(input); touch(allocation, now);
    return result(state, ctx, input, "Allocation review recorded.", allocation);
  }
  if (input.action === "resolve_exception") {
    assertActionRole(ctx, ["Admin", "Finance", "Operations"]);
    const allowed = ["allocated", "duplicate_confirmed", "no_action_required", "mandate_reissued", "customer_contacted", "ownership_corrected", "evidence_received", "refunded_externally"];
    if (!allowed.includes(String(data.resolutionCode))) throw new Error("Invalid structured exception resolution code.");
    const item = findRecord(state, String(input.recordId), "exceptions"); item.status = "resolved"; item.data.resolutionCode = data.resolutionCode; item.data.notes = reason(input); touch(item, now);
    return result(state, ctx, input, "Exception resolution recorded.", item);
  }
  if (input.action === "record_refund") {
    assertActionRole(ctx, ["Admin", "Finance"]);
    if (!data.reference || /^\d{8,}$/.test(String(data.reference))) throw new Error("A masked synthetic external refund reference is required.");
    const payment = findRecord(state, String(input.recordId), "payments"); payment.data.refundStatus = "recorded_externally"; payment.data.refundReference = String(data.reference); touch(payment, now);
    return result(state, ctx, input, "External refund reference recorded; Valo did not move funds.", payment);
  }
  if (input.action === "simulate_failure") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    const due = findRecord(state, String(input.recordId), "due-items");
    if (!data.failureCode) throw new Error("data.failureCode is required.");
    const attempts = recordsOf(state, "attempts").filter((item) => item.data.dueItemId === due.id);
    const attempt = makeRecord(state, "attempts", { name: "Simulated external failed attempt", status: "failed", customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, number: attempts.length + 1, source: "external", simulated: true, failureCode: data.failureCode, occurredAt: now, actualInstruction: false } });
    return result(state, ctx, input, "Synthetic failure recorded for policy backtest only; no debit was attempted.", attempt);
  }
  if (input.action === "backtest_policy") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance", "Compliance reviewer"]);
    const policy = findRecord(state, String(input.recordId), "policies");
    const decisions = recordsOf(state, "due-items").filter((due) => policyIdFor(state,due) === policy.id).map(due=>evaluateRetry(state,ctx,due,policy));
    return result(state, ctx, input, "Backtest shows scheduling constraints only and makes no recovery claim.", policy, { decisions, recoveryEstimate: null, notARecoveryClaim: true });
  }
  if (input.action === "preregister_experiment") {
    assertActionRole(ctx, ["Admin"]);
    const experiment = findRecord(state, String(input.recordId), "experiments");
    if (experiment.status !== "draft") throw new Error("Experiment parameters are already frozen.");
    const policy = recordsOf(state, "policies").find((item) => item.id === experiment.data.policyId && item.status === "approved");
    if (!policy) throw new Error("A preregistered experiment requires an approved policy.");
    const analysis=Date.parse(experiment.data.analysisDate),close=Date.parse(experiment.data.enrolmentClose);
    if(!Number.isFinite(analysis)||!Number.isFinite(close)||close>Date.parse(experiment.data.analysisDate)-30*86400000||close<=Date.parse(now))throw new Error("Enrolment must close in the future and at least 30 days before analysis.");
    experiment.data.sampleCalculation=preregisterSample(Number(experiment.data.baselineRate),Number(experiment.data.holdoutShare));
    experiment.data.minPerArm=Math.max(Number(experiment.data.minPerArm||0),experiment.data.sampleCalculation.holdoutMinimum);
    experiment.status = "preregistered"; experiment.data.preregisteredAt = now; experiment.data.parametersFrozen = true;
    touch(experiment, now); return result(state, ctx, input, "Parameters frozen. Assignment occurs once at the first eligible future retryable failure, never at preregistration.", experiment, { assigned: 0 });
  }
  if (input.action === "hand_back") {
    assertActionRole(ctx, ["Admin", "Operations"]);
    recordsOf(state, "due-items").filter((item) => item.data.owner === "valopay").forEach((item) => { item.data.owner = "lms"; item.data.handBackAt = now; touch(item, now); });
    recordsOf(state, "attempts").filter((item) => item.status === "scheduled").forEach((item) => { item.status = "cancelled"; item.data.cancellationReason = "Synthetic hand-back"; touch(item, now); });
    state.merchant.killSwitch = true;
    const cutover = makeRecord(state, "cutovers", { name: "Synthetic hand-back", status: "handed_back", data: { checklist: ["Valo ownership restored to LMS", "scheduled simulated attempts cancelled", "no external instruction sent"], confirmation: reason(input) } });
    return result(state, ctx, input, "Synthetic hand-back completed.", cutover);
  }
  if (input.action === "mark_pack_used") throw new Error("Synthetic exports can never be counted as real cases.");
  throw new Error(`Unsupported domain action: ${input.action}.`);
}