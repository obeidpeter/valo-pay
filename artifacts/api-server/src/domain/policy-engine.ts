import { createHash } from "node:crypto";
import {
  ABSOLUTE_TICKET_FLOOR_KOBO, DEFAULT_MINIMUM_TICKET_KOBO, PLATFORM_OWNER, WAT_OFFSET_MS,
  clampExecutionHour, executionWindow, experimentRules, normaliseFailureCode, policyGuardrails, retryRuleFor,
  type FailureCode,
} from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "./types";
import { recordsOf } from "./records";
import { holidaySet, isBusinessDay } from "./calendar";

const HOUR = 60 * 60 * 1000;

export type RetryDecisionKind = "stop" | "blocked" | "give_up" | "not_eligible" | "holdout" | "observation_only" | "defer" | "would_schedule";
export interface RetryDecision {
  dueItemId: string;
  decision: RetryDecisionKind;
  /** The decision-table row that fired (TRD 6.3), for the audit timeline (RET-03). */
  rule: string;
  reason: string;
  nextAt: string | null;
  policyVersion: unknown;
  inputs: Record<string, unknown>;
}

export function policyIdFor(state: DomainState, due: ValopayRecord): string | undefined {
  return due.data.policyId || state.records.find((r) => r.kind === "mandates" && r.id === due.data.mandateId)?.data.policyId;
}

export function approvedPolicyFor(state: DomainState, due: ValopayRecord): ValopayRecord | undefined {
  const id = policyIdFor(state, due);
  return id ? recordsOf(state, "policies").find((policy) => policy.id === id && policy.status === "approved") : undefined;
}

export const attemptTime = (attempt: ValopayRecord): string => String(attempt.data.occurredAt || attempt.createdAt);

export function attemptsFor(state: DomainState, dueItemId: string): ValopayRecord[] {
  return recordsOf(state, "attempts").filter((attempt) => attempt.data.dueItemId === dueItemId).sort((a, b) => attemptTime(a).localeCompare(attemptTime(b)));
}

/** Attempts the customer experienced.  Cancelled and not-yet-sent attempts never count toward the ceiling (DEB-05). */
export const countedAttemptStatuses: ReadonlySet<string> = new Set(["sent", "succeeded", "failed", "unknown", "reversed"]);
export function countedAttempts(state: DomainState, dueItemId: string): ValopayRecord[] {
  return attemptsFor(state, dueItemId).filter((attempt) => countedAttemptStatuses.has(attempt.status));
}

/** MAN-07: the merchant's minimum (default ₦10,000) can never sit below the absolute ₦5,000 floor. */
export function minimumTicketKobo(state: DomainState): number {
  const configured = Number(state.settings.minimumTicketKobo);
  const minimum = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MINIMUM_TICKET_KOBO;
  return Math.max(ABSOLUTE_TICKET_FLOOR_KOBO, minimum);
}

/** DEB-06: policy-version switches live in merchant settings because approved policy versions are immutable. */
export function policyKillSwitchOn(state: DomainState, policyId: string | undefined): boolean {
  return !!policyId && state.settings.policyKillSwitches?.[policyId] === true;
}

export function policyCeiling(policy: ValopayRecord): number {
  const configured = Number(policy.data.maxAttempts);
  const maximum = Number.isInteger(configured) && configured >= 1 ? configured : policyGuardrails.defaultMaxAttempts;
  return Math.min(policyGuardrails.maxAttemptsCeiling, maximum);
}

export function executionWindowFor(state: DomainState): { start: number; end: number } {
  return {
    start: clampExecutionHour(state.settings.executionStart, executionWindow.defaultStartHour),
    end: clampExecutionHour(state.settings.executionEnd, executionWindow.defaultEndHour),
  };
}

/**
 * Earliest instant at or after `earliestMs` that falls on a business day inside
 * the merchant's execution window (DEB-01, SCH-04).  Returns NaN when the window
 * is empty.  The window is [start, end) in WAT hours and is hard-bounded to
 * 06:00–20:00 whatever the settings say.
 */
export function nextExecutionSlot(state: DomainState, earliestMs: number): number {
  const holidays = holidaySet(state);
  const { start, end } = executionWindowFor(state);
  if (start >= end || !Number.isFinite(earliestMs)) return NaN;
  const atHour = (wat: Date, hour: number) => { wat.setUTCHours(hour, 0, 0, 0); return wat.getTime() - WAT_OFFSET_MS; };
  let time = earliestMs;
  for (let day = 0; day < 370; day++) {
    const wat = new Date(time + WAT_OFFSET_MS);
    if (!isBusinessDay(time, holidays) || wat.getUTCHours() >= end) {
      wat.setUTCDate(wat.getUTCDate() + 1);
      time = atHour(wat, start);
      continue;
    }
    if (wat.getUTCHours() < start) return atHour(wat, start);
    return time;
  }
  return NaN;
}

function overrideRecorded(due: ValopayRecord): boolean {
  return Boolean(due.data.overrideReason || due.data.adminOverrideReason);
}

/**
 * TRD 6.3 decision table, applied after a failed attempt.  Rows fire in the
 * documented order; ownership and mode are evaluated last so a backtest can
 * show what the policy would have done while the merchant observes.
 */
export function evaluateRetry(state: DomainState, ctx: Context, due: ValopayRecord, policy: ValopayRecord): RetryDecision {
  const attempts = attemptsFor(state, due.id);
  const counted = countedAttempts(state, due.id);
  const last = counted.at(-1);
  const code: FailureCode | undefined = last?.status === "failed" ? normaliseFailureCode(last.data.failureCode) : undefined;
  const inputs: Record<string, unknown> = { code, attemptNumber: counted.length, ceiling: policyCeiling(policy), owner: due.data.owner, mode: state.merchant.mode };
  const explain = (decision: RetryDecisionKind, rule: string, reason: string, nextAt: string | null = null): RetryDecision =>
    ({ dueItemId: due.id, decision, rule, reason, nextAt, policyVersion: policy.data.version, inputs });

  // Row 1: settled by any channel, or the obligation is frozen or closed.
  const outstanding = Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
  if (["paid", "cancelled", "closed"].includes(due.status) || outstanding === 0) return explain("stop", "settled", "Due item settled by any channel or closed; any planned retry is cancelled.");
  if (due.status === "in_dispute") return explain("stop", "disputed", "Due item is frozen while a customer dispute is open.");
  if (due.status === "unpaid_final") return explain("stop", "final", "Attempts are exhausted; the exception and the LMS already hold this item.");
  // Row 2: kill switches.  No exception for the switch itself; the item waits for release.
  if (state.merchant.killSwitch) return explain("blocked", "kill_switch", "Merchant kill switch is active; no instruction is planned.");
  if (policyKillSwitchOn(state, policy.id)) return explain("blocked", "kill_switch", "Policy version kill switch is active; no instruction is planned.");
  // Unknown or in-flight outcome: resolve by status query before anything else happens to the due item (DEB-04).
  if (attempts.some((attempt) => ["scheduled", "sent", "unknown"].includes(attempt.status))) {
    return explain("blocked", "in_flight", "An in-flight or unknown outcome must be resolved by status query before anything else happens to this due item.");
  }
  if (!last || last.status !== "failed" || !code) return explain("not_eligible", "no_failure", "No failed attempt to re-present.");
  inputs.rawCode = last.data.failureCode;
  const retry = retryRuleFor(code);
  if (retry === "never") return explain("stop", "customer_disputed", "CUSTOMER_DISPUTED freezes the due item; a dispute exception with a one-day SLA is raised.");
  if (retry === "unresolved") return explain("blocked", "timeout_unknown", "TIMEOUT_UNKNOWN: query the provider by reference; an exception is raised after 24 hours.");
  // Row 3: non-retryable code.
  if (retry === "no") return explain("give_up", "non_retryable", `${code} is not retryable: final notice, exception and LMS informed.`);
  // Row 4: attempt ceiling across every source.
  if (counted.length >= policyCeiling(policy)) return explain("give_up", "ceiling", `Attempt ceiling of ${policyCeiling(policy)} reached counting every source: final notice, exception and LMS informed.`);
  // Row 5: ACCOUNT_RESTRICTED is retried once only.
  if (retry === "once" && counted.filter((attempt) => attempt.status === "failed" && normaliseFailureCode(attempt.data.failureCode) === code).length >= 2) {
    return explain("give_up", "restricted_once", `${code} has already been re-presented once: final notice, exception and LMS informed.`);
  }
  // RET-01: only an approved version by a reviewer who is not its author may plan a retry.
  if (policy.status !== "approved" || !policy.data.reviewer || policy.data.reviewer === policy.data.author) return explain("blocked", "unapproved_policy", "Independent compliance approval is required before a retry can be planned.");
  // MAN-07: the absolute floor and the merchant minimum.
  if (due.amountKobo < ABSOLUTE_TICKET_FLOOR_KOBO) return explain("stop", "floor", "Below the absolute ₦5,000 ticket floor; refused with no override.");
  if (due.amountKobo < minimumTicketKobo(state) && !overrideRecorded(due)) return explain("blocked", "minimum_ticket", "Below the merchant minimum ticket and no merchant Admin override is recorded.");
  // MAN-08, MAN-09, MAN-14: the mandate must be active, cover the amount and carry consent.
  const mandate = state.records.find((record) => record.kind === "mandates" && record.id === due.data.mandateId);
  if (!mandate || mandate.status !== "active") return explain("blocked", "mandate_inactive", "Mandate is not active.");
  if (due.amountKobo > mandate.amountKobo) return explain("blocked", "mandate_limit", "Due amount exceeds the mandate limit; never re-sent at a lower amount without consent coverage.");
  if (!mandate.data.consentEvidence || (Array.isArray(mandate.data.consentGaps) && mandate.data.consentGaps.length)) return explain("blocked", "consent_gap", "Consent evidence is missing or imported gaps are unresolved.");
  // Row 6: stable experiment assignment (RET-05).
  if (due.data.experimentArm === "holdout") return explain("holdout", "holdout", "Stable holdout assignment: the lender's documented manual process owns this item; the engine must not retry.");
  // SCH-08 and DEB-10: only owner-valo obligations of a merchant in instruction mode are instructed.
  if (due.data.owner !== PLATFORM_OWNER) return explain("observation_only", "ownership", `Execution belongs to ${due.data.owner}; Valo Pay cannot instruct this obligation.`);
  if (state.merchant.mode !== "instruction" || !state.merchant.preLiveReady) return explain("observation_only", "observation_mode", "Instruction gate remains closed; synthetic evidence cannot open it.");
  // NOT-10: the notice clock runs from provider acceptance, never from submission or simulation.
  const notice = recordsOf(state, "notifications").find((record) => record.id === last.data.noticeId && ["pre_debit", "failed_debit"].includes(String(record.data.purpose)) && record.data.acceptedAt && record.data.synthetic !== true);
  if (!notice) return explain("defer", "notice_not_evidenced", "Required notice has no provider acceptance evidence; the attempt is deferred and a notice-not-evidenced exception is raised.");
  // Row 7: the earliest slot that satisfies spacing, the notice lead time, the calendar and the window.
  const spacingHours = Math.max(policyGuardrails.minSpacingHours, Number(policy.data.spacingHours) || policyGuardrails.defaultSpacingHours);
  const leadHours = Math.max(policyGuardrails.minRetryNoticeHours, Number(policy.data.retryNoticeHours) || policyGuardrails.defaultRetryNoticeHours);
  const earliest = Math.max(Date.parse(ctx.now), Date.parse(attemptTime(last)) + spacingHours * HOUR, Date.parse(String(notice.data.acceptedAt)) + leadHours * HOUR);
  Object.assign(inputs, { spacingHours, leadHours, noticeAcceptedAt: notice.data.acceptedAt, window: executionWindowFor(state) });
  const next = nextExecutionSlot(state, earliest);
  if (!Number.isFinite(next)) return explain("blocked", "window", "Execution window has no valid business-day slot.");
  return explain("would_schedule", "plan", "All policy checks passed in a read-only evaluation; no instruction is sent.", new Date(next).toISOString());
}

/** Section 6.6 minimum sample per arm at 80% power for an 8-point difference, one-sided 5% (a 90% interval excluding zero). */
export function preregisterSample(baseline: number, holdout: number) {
  if (!(baseline > 0 && baseline < 1 - experimentRules.effectPoints && holdout >= experimentRules.minimumHoldoutShare && holdout <= experimentRules.maximumHoldoutShare)) {
    throw new Error("Choose a baseline between 0 and 0.92 and a 10–50% holdout.");
  }
  const ratio = (1 - holdout) / holdout;
  const z = 1.64485362695147 + 0.8416212335729143;
  const effect = experimentRules.effectPoints;
  const holdoutMinimum = Math.ceil((z * z * (baseline * (1 - baseline) + ((baseline + effect) * (1 - baseline - effect)) / ratio)) / (effect * effect));
  return { holdoutMinimum, engineMinimum: Math.ceil(holdoutMinimum * ratio), confidence: experimentRules.confidence, power: experimentRules.power, effect };
}

/** Seeded, stable arm assignment (RET-05): the same seed and due item always land in the same arm. */
export function assignArm(seed: string, merchantId: string, dueItemId: string, holdoutShare: number): "engine" | "holdout" {
  const hash = createHash("sha256").update(`${seed}:${merchantId}:${dueItemId}`).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0x100000000 < holdoutShare ? "holdout" : "engine";
}

/**
 * RET-10 eligibility: an enrolled lender's due item whose first counted attempt
 * failed with a retryable code, owned by Valo Pay, with an active mandate and no
 * dispute, not amended after the failure, inside the enrolment window.
 */
export function enrolEligibleFailures(state: DomainState, ctx: Context): void {
  for (const due of recordsOf(state, "due-items")) {
    if (due.data.experimentId || due.data.owner !== PLATFORM_OWNER) continue;
    if (["cancelled", "closed", "in_dispute", "paid", "unpaid_final"].includes(due.status) || due.amountKobo < ABSOLUTE_TICKET_FLOOR_KOBO) continue;
    const counted = countedAttempts(state, due.id);
    const first = counted[0];
    if (!first || first.status !== "failed") continue;
    const retry = retryRuleFor(first.data.failureCode);
    if (retry !== "yes" && retry !== "once") continue;
    if (counted.some((attempt) => normaliseFailureCode(attempt.data.failureCode) === "CUSTOMER_DISPUTED")) continue;
    const mandate = state.records.find((record) => record.kind === "mandates" && record.id === due.data.mandateId);
    if (!mandate || mandate.status !== "active") continue;
    const failureAt = attemptTime(first);
    if (due.data.amendedAt && String(due.data.amendedAt) > failureAt) continue;
    const experiment = recordsOf(state, "experiments").find((item) =>
      item.status === "preregistered" && item.data.policyId === policyIdFor(state, due) && failureAt >= String(item.data.preregisteredAt) && failureAt <= `${item.data.enrolmentClose}T23:59:59.999Z`,
    );
    if (!experiment) continue;
    due.data.experimentId = experiment.id;
    due.data.experimentArm = assignArm(String(experiment.data.seed), state.merchant.id, due.id, Number(experiment.data.holdoutShare));
    due.data.firstFailureAt = failureAt;
    due.data.assignmentAt = ctx.now;
    due.updatedAt = ctx.now;
  }
}
