import { DESIGN_PARTNER_DISCOUNT, DESIGN_PARTNER_DISCOUNT_YEAR, USAGE_FEE_BPS, USAGE_FEE_CAP_KOBO, isOpenException, licenceTierFor, usageFeeKobo } from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { DomainState, Metric, Report, ValopayRecord } from "./types";
import { paymentObservedAt, paymentRefunded, paymentReversed } from "./reconciliation";

const DAY_MS = 24 * 60 * 60 * 1000;
const monthOf = (value: string) => value.slice(0, 7);
const metric = (key: string, label: string, value: number, unit: string, detail: string): Metric => ({ key, label, value, unit, detail });

/** BIL-01: billable when collection succeeded, the Payment is settled, carries no reversal or refund, and the reversal window has passed. */
function paymentEligible(payment: ValopayRecord, now: string, windowDays: number): boolean {
  return ["allocated", "overpaid", "partial"].includes(payment.status) && payment.data.collectionStatus === "succeeded" && payment.data.settlementStatus === "settled" &&
    !paymentReversed(payment) && !paymentRefunded(payment) && Date.parse(now) - paymentObservedAt(payment) >= windowDays * DAY_MS;
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
  const reversalWindowDays = Number(state.settings.reversalWindowDays || 7);
  const billablePayments = payments.filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === period && paymentEligible(item, now, reversalWindowDays));
  const usageBase = billablePayments.reduce((sum, item) => sum + Number(item.data.allocatedKobo || item.amountKobo), 0);
  const usageFee = billablePayments.reduce((sum, item) => sum + usageFeeKobo(Number(item.data.allocatedKobo || item.amountKobo)), 0);
  const tier = licenceTierFor(billablePayments.length);
  const lines = commercial.map((item) => {
    const designDiscount = item.data.designPartner === true && period.startsWith(DESIGN_PARTNER_DISCOUNT_YEAR) ? DESIGN_PARTNER_DISCOUNT : 1;
    const usage = Math.floor(usageFee * designDiscount);
    const contractedLicence = Number(item.data.licenceKobo || 0);
    const licence = Math.floor(contractedLicence * designDiscount);
    return { commercialId: item.id, prospect: item.name, implementationKobo: 0, licenceKobo: licence, contractedLicenceKobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, usageKobo: usage, totalKobo: licence + usage, designPartnerDiscount: designDiscount < 1 };
  });
  const billing = {
    period, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO, reversalWindowDays,
    eligibleAllocatedKobo: usageBase, successfulCollections: billablePayments.length, volumeTier: tier.name, lines, totalKobo: lines.reduce((sum, line) => sum + line.totalKobo, 0),
    implementationExcludedFromRecurring: true, synthetic: true,
  };

  const experiments = recordsOf(state, "experiments").filter((item) => item.status === "preregistered" || item.status === "closed");
  const experimentRows = experiments.map((experiment) => {
    const enrolled = dueItems.filter((due) => due.data.experimentId === experiment.id);
    const arms = { engine: enrolled.filter((d) => d.data.experimentArm === "engine"), holdout: enrolled.filter((d) => d.data.experimentArm === "holdout") };
    const matured = (due: ValopayRecord) => Date.parse(now) >= Date.parse(String(due.data.firstFailureAt || due.createdAt)) + 30 * DAY_MS;
    const rate = (items: ValopayRecord[]) => {
      const completed = items.filter(matured);
      const denominator = completed.reduce((s, d) => s + d.amountKobo, 0);
      const numerator = completed.reduce((sum, due) => {
        const start = Date.parse(String(due.data.firstFailureAt || due.createdAt)), end = start + 30 * DAY_MS;
        const recovered = allocations.filter((a) => a.status === "confirmed" && a.data.dueItemId === due.id).reduce((total, a) => {
          const payment = payments.find((p) => p.id === a.data.paymentId);
          if (!payment || payment.data.settlementStatus !== "settled" || paymentReversed(payment) || paymentRefunded(payment)) return total;
          const settled = Date.parse(payment.data.settledAt || payment.createdAt);
          return settled >= start && settled <= end ? total + a.amountKobo : total;
        }, 0);
        return sum + Math.min(due.amountKobo, recovered);
      }, 0);
      return denominator ? numerator / denominator : 0;
    };
    const min = Number(experiment.data.minPerArm || 0);
    return {
      experimentId: experiment.id, engine: arms.engine.length, holdout: arms.holdout.length, matureEngine: arms.engine.filter(matured).length, matureHoldout: arms.holdout.filter(matured).length,
      engineRecoveryByValue: rate(arms.engine), holdoutRecoveryByValue: rate(arms.holdout), minimumPerArm: min, passRule: experiment.data.passRule ?? null, confidenceInterval90: null, result: "not_proven",
      reason: arms.engine.filter(matured).length < min || arms.holdout.filter(matured).length < min ? "Insufficient mature 30-day outcomes per preregistered arm." : "Synthetic results cannot establish a recovery claim; independent inference validation is required.", synthetic: true,
    };
  });
  return {
    metrics,
    billing,
    experiment: { results: experimentRows, result: "not_proven", synthetic: true },
    operational: {
      allocationRate, precision,
      certainAutomaticRate: payments.length ? new Set(automaticCertain.map((a) => a.data.paymentId)).size / payments.length : 0,
      reviewedCount: reviewedAll.length, reviewedAutomaticCount: reviewed.length, falseMatchRate: reviewedAll.length ? 1 - precision : null, requiredAuditSample: Math.min(200, automaticCertain.length),
      overdueExceptionRate: openExceptions.length ? openExceptions.filter((e) => Date.parse(String(e.data.dueBy)) < Date.parse(now)).length / openExceptions.length : 0,
      liveDays: 0, requiredLiveDays: 60, realCasesUsed: 0, requiredRealCases: 5, fortnightlyStaffConfirmed: false, monthEndCloseBusinessDays: null,
      unallocatedOlderThan24Hours: unallocated.filter((item) => Date.parse(now) - paymentObservedAt(item) >= DAY_MS).length, proof: false, reason: "All measurements are synthetic and are not operational proof.",
    },
    closes: closeRecords,
  };
}
