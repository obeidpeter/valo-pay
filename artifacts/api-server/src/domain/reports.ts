import {
  DEFAULT_REVERSAL_WINDOW_DAYS, DESIGN_PARTNER_DISCOUNT, DESIGN_PARTNER_DISCOUNT_YEAR, USAGE_FEE_BPS, USAGE_FEE_CAP_KOBO, billableChannels,
  experimentRules, isBillableChannel, isOpenException, licenceTierFor, usageFeeKobo,
} from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { DomainState, Metric, Report, ValopayRecord } from "./types";
import { paymentObservedAt, paymentRefunded, paymentReversed } from "./reconciliation";

const DAY_MS = 24 * 60 * 60 * 1000;
const monthOf = (value: string) => value.slice(0, 7);
const metric = (key: string, label: string, value: number, unit: string, detail: string): Metric => ({ key, label, value, unit, detail });
const round = (value: number, places = 6) => Number(value.toFixed(places));

/** BIL-01: the provider's own reversal window when configured, else the merchant's, else the plan's seven days. */
export function reversalWindowDays(state: DomainState, provider: unknown): number {
  const perProvider = (state.settings.providerReversalWindowDays || {}) as Record<string, unknown>;
  for (const candidate of [perProvider[String(provider)], state.settings.reversalWindowDays, DEFAULT_REVERSAL_WINDOW_DAYS]) {
    const days = Number(candidate);
    if (Number.isFinite(days) && days >= 0) return days;
  }
  return DEFAULT_REVERSAL_WINDOW_DAYS;
}

/**
 * BIL-01: a collection is billable when its attempt succeeded (a direct debit
 * the platform observed), the Payment is settled and allocated, carries no
 * reversal or refund at the invoice date, and the provider's reversal window
 * has passed.  Transfers, card receipts and statement credits are reconciled
 * and reported, never billed as collections.
 */
export function billableCollection(state: DomainState, payment: ValopayRecord, now: string, checkWindow = true): boolean {
  if (!isBillableChannel(payment.data.channel) || payment.data.collectionStatus !== "succeeded") return false;
  if (!["allocated", "overpaid", "partial"].includes(payment.status) || payment.data.settlementStatus !== "settled") return false;
  if (paymentReversed(payment) || paymentRefunded(payment)) return false;
  return !checkWindow || Date.parse(now) - paymentObservedAt(payment) >= reversalWindowDays(state, payment.data.providerConnection || state.merchant.provider) * DAY_MS;
}

/** Queue counts and headline metrics for the console overview; dashboards beyond this are stage 2 (UI-01). */
export function buildOverview(state: DomainState, now: string) {
  const by = (kind: string) => recordsOf(state, kind);
  const settled = by("payments").filter((item) => item.data.settlementStatus === "settled" && item.status !== "possible_duplicate" && !paymentReversed(item));
  const outstanding = by("due-items").reduce((sum, item) => sum + Number(item.data.outstandingKobo ?? item.amountKobo), 0);
  const certainPayments = new Set(by("allocations").filter((item) => item.status === "confirmed" && item.data.confidence === "certain").map((item) => item.data.paymentId));
  const open = by("exceptions").filter((item) => isOpenException(item.status));
  return {
    metrics: [
      metric("settled", "Reconciled collections", settled.reduce((sum, item) => sum + Number(item.data.allocatedKobo || 0), 0), "kobo", "Canonical settled payments, counted once · synthetic"),
      metric("outstanding", "Outstanding obligations", outstanding, "kobo", "Derived from due items, not a funds balance"),
      metric("match_rate", "Certain match rate", settled.length ? Math.round((settled.filter((item) => certainPayments.has(item.id)).length / settled.length) * 100) : 0, "percent", "Synthetic sample only; not Test 5 evidence"),
      metric("exceptions", "Open exceptions", open.length, "count", "Items requiring an accountable owner"),
    ],
    queues: [
      metric("activation", "Awaiting activation", by("mandates").filter((item) => item.status === "pending_activation").length, "count", "Provider-specific workflows"),
      metric("review", "Matches to review", by("payments").filter((item) => item.status === "proposed").length, "count", "Finance confirmation required"),
      metric("duplicates", "Possible duplicates", by("payments").filter((item) => item.status === "possible_duplicate").length, "count", "Held for Finance; never auto-allocated"),
      metric("failures", "Failed collections", by("attempts").filter((item) => item.status === "failed").length, "count", "Observed external attempts"),
      metric("overdue", "Overdue exceptions", open.filter((item) => Date.parse(String(item.data.dueBy)) < Date.parse(now)).length, "count", "Escalate to the assigned owner"),
    ],
    activity: by("audit").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    upcoming: by("due-items").filter((item) => !["paid", "closed", "cancelled"].includes(item.status)).slice(0, 6),
    mode: state.merchant.mode, environment: "sandbox", lastClose: by("closes").at(-1)?.createdAt || "Not closed yet",
  };
}

// ---------- RET-06: the uplift report ----------

interface ArmOutcome { due: ValopayRecord; recoveredKobo: number; settledInFull: boolean }
export interface ArmStatistics {
  enrolled: number;
  mature: number;
  totalDueKobo: number;
  recoveredKobo: number;
  settledInFull: number;
  recoveryByValue: number;
  recoveryByCount: number;
  /** Linearised (ratio-estimator) variance of the value-weighted rate; null below two mature items. */
  varianceByValue: number | null;
  varianceByCount: number | null;
}

/** 6.6: settlement of the due item by any channel within 30 days of the first failure, by value (partials count) and by count. */
function outcomeWithinWindow(state: DomainState, due: ValopayRecord): ArmOutcome {
  const start = Date.parse(String(due.data.firstFailureAt || due.createdAt)), end = start + experimentRules.outcomeWindowDays * DAY_MS;
  const payments = recordsOf(state, "payments");
  const recovered = recordsOf(state, "allocations").filter((a) => a.status === "confirmed" && a.data.dueItemId === due.id).reduce((total, allocation) => {
    const payment = payments.find((p) => p.id === allocation.data.paymentId);
    if (!payment || payment.data.settlementStatus !== "settled" || paymentReversed(payment) || paymentRefunded(payment)) return total;
    const settled = Date.parse(String(payment.data.settledAt || payment.data.observedAt || payment.createdAt));
    return settled >= start && settled <= end ? total + allocation.amountKobo : total;
  }, 0);
  const recoveredKobo = Math.min(due.amountKobo, recovered);
  return { due, recoveredKobo, settledInFull: recoveredKobo >= due.amountKobo };
}

export function armStatistics(state: DomainState, items: ValopayRecord[], now: string): ArmStatistics {
  const matured = items.filter((due) => Date.parse(now) >= Date.parse(String(due.data.firstFailureAt || due.createdAt)) + experimentRules.outcomeWindowDays * DAY_MS);
  const outcomes = matured.map((due) => outcomeWithinWindow(state, due));
  const n = outcomes.length;
  const totalDueKobo = outcomes.reduce((sum, item) => sum + item.due.amountKobo, 0);
  const recoveredKobo = outcomes.reduce((sum, item) => sum + item.recoveredKobo, 0);
  const settledInFull = outcomes.filter((item) => item.settledInFull).length;
  const byValue = totalDueKobo ? recoveredKobo / totalDueKobo : 0;
  const byCount = n ? settledInFull / n : 0;
  let varianceByValue: number | null = null, varianceByCount: number | null = null;
  if (n > 1 && totalDueKobo > 0) {
    // Ratio estimator p = Σwᵢyᵢ / Σwᵢ with yᵢ the recovered share of due item i; Taylor-linearised variance.
    const meanWeight = totalDueKobo / n;
    const residuals = outcomes.map((item) => (item.due.amountKobo * (item.recoveredKobo / item.due.amountKobo - byValue)) / meanWeight);
    varianceByValue = residuals.reduce((sum, r) => sum + r * r, 0) / (n * (n - 1));
    varianceByCount = (byCount * (1 - byCount)) / n;
  }
  return { enrolled: items.length, mature: n, totalDueKobo, recoveredKobo, settledInFull, recoveryByValue: byValue, recoveryByCount: byCount, varianceByValue, varianceByCount };
}

function interval(difference: number, varianceA: number | null, varianceB: number | null): { low: number; high: number; standardError: number } | null {
  if (varianceA === null || varianceB === null) return null;
  const standardError = Math.sqrt(varianceA + varianceB);
  return { low: round(difference - experimentRules.zScore * standardError), high: round(difference + experimentRules.zScore * standardError), standardError: round(standardError) };
}

/** RET-06 and RET-11: the uplift report per lender with the pre-registered rule evaluated exactly as written. */
export function upliftReport(state: DomainState, experiment: ValopayRecord, now: string) {
  const enrolled = recordsOf(state, "due-items").filter((due) => due.data.experimentId === experiment.id);
  const engine = armStatistics(state, enrolled.filter((due) => due.data.experimentArm === "engine"), now);
  const holdout = armStatistics(state, enrolled.filter((due) => due.data.experimentArm === "holdout"), now);
  const minimumPerArm = Number(experiment.data.minPerArm || 0);
  const differenceByValue = round(engine.recoveryByValue - holdout.recoveryByValue);
  const differenceByCount = round(engine.recoveryByCount - holdout.recoveryByCount);
  const confidenceInterval90 = interval(differenceByValue, engine.varianceByValue, holdout.varianceByValue);
  const confidenceInterval90ByCount = interval(differenceByCount, engine.varianceByCount, holdout.varianceByCount);
  const analysisDate = String(experiment.data.analysisDate || "");
  const checks = {
    effectAtLeastEightPoints: differenceByValue >= experimentRules.effectPoints,
    intervalExcludesZero: confidenceInterval90 !== null && confidenceInterval90.low > 0,
    sampleMet: engine.mature >= minimumPerArm && holdout.mature >= minimumPerArm && minimumPerArm > 0,
    analysisDateReached: Boolean(analysisDate) && now.slice(0, 10) >= analysisDate.slice(0, 10),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const result = failed.length ? "not_proven" : "proven";
  const reason = failed.length
    ? `Not proven: ${failed.map((name) => ({ effectAtLeastEightPoints: "the difference by value is below 8 points", intervalExcludesZero: "the 90% interval does not exclude zero", sampleMet: "an arm is below the pre-computed minimum of mature outcomes", analysisDateReached: "the analysis date has not been reached" })[name]).join("; ")}.`
    : "Proven for this lender on the pre-registered rule; the recovery-fee decision needs the same result for each design partner.";
  return {
    experimentId: experiment.id, status: experiment.status, passRule: experiment.data.passRule ?? null, preregisteredAt: experiment.data.preregisteredAt ?? null,
    analysisDate: analysisDate || null, enrolmentClose: experiment.data.enrolmentClose ?? null, holdoutShare: Number(experiment.data.holdoutShare), seed: experiment.data.seed ?? null,
    outcomeWindowDays: experimentRules.outcomeWindowDays, minimumPerArm,
    engine: { ...engine, recoveryByValue: round(engine.recoveryByValue), recoveryByCount: round(engine.recoveryByCount) },
    holdout: { ...holdout, recoveryByValue: round(holdout.recoveryByValue), recoveryByCount: round(holdout.recoveryByCount) },
    differenceByValue, differenceByCount, confidenceInterval90, confidenceInterval90ByCount, confidence: experimentRules.confidence,
    checks, result, reason,
    // Compatibility fields read by earlier console builds.
    enrolled: enrolled.length, engineRecoveryByValue: round(engine.recoveryByValue), holdoutRecoveryByValue: round(holdout.recoveryByValue), matureEngine: engine.mature, matureHoldout: holdout.mature,
    synthetic: true,
  };
}

/** MEA-01 time to close: days from a month end to the first close with no unallocated Payment older than 24 hours. */
export function timeToClose(state: DomainState, now: string): { month: string; days: number | null; closeId: string | null; closedAt: string | null } | null {
  const closes = recordsOf(state, "closes").filter((close) => close.data.report).sort((a, b) => String(a.data.closedAt).localeCompare(String(b.data.closedAt)));
  if (!closes.length) return null;
  const current = new Date(now);
  const monthEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)); // first instant of this month = end of last month
  const month = new Date(monthEnd.getTime() - DAY_MS).toISOString().slice(0, 7);
  const clean = closes.find((close) => String(close.data.closedAt) >= monthEnd.toISOString() && Number(close.data.report?.unallocated?.olderThan24Hours ?? 1) === 0);
  return { month, days: clean ? round((Date.parse(String(clean.data.closedAt)) - monthEnd.getTime()) / DAY_MS, 2) : null, closeId: clean?.id ?? null, closedAt: clean ? String(clean.data.closedAt) : null };
}

export function buildReports(state: DomainState, now: string): Report {
  const payments = recordsOf(state, "payments");
  const allocations = recordsOf(state, "allocations");
  const dueItems = recordsOf(state, "due-items");
  const exceptions = recordsOf(state, "exceptions");
  const closeRecords = recordsOf(state, "closes");
  const allocated = payments.filter((item) => ["allocated", "partial", "overpaid"].includes(item.status));
  const allocationRate = payments.length ? allocated.length / payments.length : 0;
  const automaticCertain = allocations.filter((item) => item.status === "confirmed" && item.data.automatic === true && item.data.confidence === "certain");
  const reviewed = automaticCertain.filter((item) => typeof item.data.reviewed === "boolean");
  const reviewedAll = allocations.filter((item) => typeof item.data.reviewed === "boolean");
  const precision = reviewedAll.length ? reviewedAll.filter((item) => item.data.reviewed === true).length / reviewedAll.length : 0;
  const unallocated = payments.filter((item) => item.status === "unallocated");
  const openExceptions = exceptions.filter((item) => isOpenException(item.status));
  const metrics: Metric[] = [
    metric("allocation_rate", "Allocation rate", allocationRate, "ratio", `${allocated.length} of ${payments.length} canonical payments allocated, partial or overpaid.`),
    metric("allocation_precision", "Reviewed allocation precision", precision, "ratio", `${reviewedAll.length} reviewed allocations; unreviewed work is not assumed correct.`),
    metric("open_exceptions", "Open exceptions", openExceptions.length, "count", "Synthetic exception queue."),
    metric("outstanding_kobo", "Outstanding due value", dueItems.reduce((sum, item) => sum + Number(item.data.outstandingKobo ?? item.amountKobo), 0), "kobo", "Due items only; we never hold money."),
  ];

  const period = String(state.settings.billingPeriod || monthOf(now));
  // Commercial prospects are evidence, not additional subscriptions on this tenant.
  const commercial = recordsOf(state, "commercial").filter((item) => item.name === state.merchant.name && item.data.designPartner === true && item.data.signed && String(item.data.effectiveDate || "").slice(0, 7) <= period).slice(0, 1);
  const inPeriod = payments.filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === period);
  const billablePayments = inPeriod.filter((item) => billableCollection(state, item, now));
  const usageBase = billablePayments.reduce((sum, item) => sum + Number(item.data.allocatedKobo || item.amountKobo), 0);
  const usageFee = billablePayments.reduce((sum, item) => sum + usageFeeKobo(Number(item.data.allocatedKobo || item.amountKobo)), 0);
  const tier = licenceTierFor(billablePayments.length);
  const channelBreakdown: Record<string, { count: number; kobo: number; billable: number; reason: string }> = {};
  for (const payment of inPeriod) {
    const channel = String(payment.data.channel || "manual");
    const row = (channelBreakdown[channel] ||= { count: 0, kobo: 0, billable: 0, reason: isBillableChannel(channel) ? "Direct debit attempts that succeeded are billable once settled, unreversed and past the reversal window (BIL-01)." : "Reconciled receipt, not a collection the platform executed; reported, never billed." });
    row.count += 1; row.kobo += payment.amountKobo; if (billableCollection(state, payment, now)) row.billable += 1;
  }
  // Collections that pass every BIL-01 check except the reversal window are billed on a later statement, never lost.
  const withheld = inPeriod.filter((item) => billableCollection(state, item, now, false) && !billableCollection(state, item, now));
  const lines = commercial.map((item) => {
    const designDiscount = item.data.designPartner === true && period.startsWith(DESIGN_PARTNER_DISCOUNT_YEAR) ? DESIGN_PARTNER_DISCOUNT : 1;
    const usage = Math.floor(usageFee * designDiscount);
    const contractedLicence = Number(item.data.licenceKobo || 0);
    const licence = Math.floor(contractedLicence * designDiscount);
    return { commercialId: item.id, prospect: item.name, implementationKobo: 0, licenceKobo: licence, contractedLicenceKobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, usageKobo: usage, totalKobo: licence + usage, designPartnerDiscount: designDiscount < 1 };
  });
  const billing = {
    period, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO, reversalWindowDays: reversalWindowDays(state, state.merchant.provider),
    billableChannels: [...billableChannels], billableRule: "BIL-01: a collection is billable when its direct-debit attempt succeeded, the Payment is settled and unreversed at the invoice date, and the provider's reversal window has passed.",
    eligibleAllocatedKobo: usageBase, successfulCollections: billablePayments.length, usageFeeKobo: usageFee, volumeTier: tier.name,
    channelBreakdown, withheldInsideReversalWindow: withheld.length,
    lines, totalKobo: lines.reduce((sum, line) => sum + line.totalKobo, 0),
    implementationExcludedFromRecurring: true, synthetic: true,
  };

  const experiments = recordsOf(state, "experiments").filter((item) => item.status === "preregistered" || item.status === "closed");
  const experimentRows = experiments.map((experiment) => upliftReport(state, experiment, now));
  const exports = recordsOf(state, "exports");
  const packs = exports.filter((item) => ["customer-pack", "dispute-pack", "gate-pack", "audit-pack"].includes(String(item.data.kind)));
  const closeTiming = timeToClose(state, now);
  return {
    metrics,
    billing,
    experiment: {
      results: experimentRows, result: experimentRows.length && experimentRows.every((row) => row.result === "proven") ? "proven" : "not_proven",
      note: "The recovery-fee decision needs a proven result for each design partner; a pass on one lender only is not proven (RET-11).", synthetic: true,
    },
    operational: {
      allocationRate, precision,
      certainAutomaticRate: payments.length ? new Set(automaticCertain.map((a) => a.data.paymentId)).size / payments.length : 0,
      reviewedCount: reviewedAll.length, reviewedAutomaticCount: reviewed.length, falseMatchRate: reviewedAll.length ? 1 - precision : null, requiredAuditSample: Math.min(200, automaticCertain.length),
      overdueExceptionRate: openExceptions.length ? openExceptions.filter((e) => Date.parse(String(e.data.dueBy)) < Date.parse(now)).length / openExceptions.length : 0,
      liveDays: 0, requiredLiveDays: 60,
      packsGenerated: packs.length, disputePacksGenerated: packs.filter((item) => ["customer-pack", "dispute-pack"].includes(String(item.data.kind))).length,
      realCasesUsed: packs.filter((item) => item.data.usedInRealCase === true).length, requiredRealCases: 5,
      fortnightlyStaffConfirmed: false, timeToClose: closeTiming, monthEndCloseDays: closeTiming?.days ?? null,
      unallocatedOlderThan24Hours: unallocated.filter((item) => Date.parse(now) - paymentObservedAt(item) >= DAY_MS).length, proof: false, reason: "All measurements are synthetic and are not operational proof.",
    },
    closes: closeRecords,
  };
}
