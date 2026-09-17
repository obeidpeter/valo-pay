import { recordsOf } from "./records";
import type { DomainState, Metric, Report, ValopayRecord } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const monthOf = (value: string) => value.slice(0, 7);

function paymentEligible(payment: ValopayRecord, now: string, windowDays: number): boolean {
  return payment.status === "allocated" && payment.data.collectionStatus === "succeeded" && payment.data.settlementStatus === "settled" && ["none","not_reversed"].includes(payment.data.reversalStatus) && ["none","not_refunded"].includes(payment.data.refundStatus) &&
    Date.parse(now) - Date.parse(payment.createdAt) >= windowDays * DAY_MS;
}

export function buildReports(state: DomainState, now: string): Report {
  const payments = recordsOf(state, "payments");
  const allocations = recordsOf(state, "allocations");
  const dueItems = recordsOf(state, "due-items");
  const exceptions = recordsOf(state, "exceptions");
  const closeRecords = recordsOf(state, "closes");
  const allocated = payments.filter((item) => item.status === "allocated" || item.status === "partial");
  const allocationRate = payments.length ? allocated.length / payments.length : 0;
  const reviewed = allocations.filter((item) => typeof item.data.reviewed === "boolean");
  const precision = reviewed.length ? reviewed.filter((item) => item.data.reviewed === true).length / reviewed.length : 0;
  const unallocated = payments.filter((item) => item.status === "unallocated");
  const metrics: Metric[] = [
    { key: "allocation_rate", label: "Allocation rate", value: allocationRate, unit: "ratio", detail: `${allocated.length} of ${payments.length} canonical payments allocated or partial.` },
    { key: "allocation_precision", label: "Reviewed allocation precision", value: precision, unit: "ratio", detail: `${reviewed.length} reviewed allocations; unreviewed work is not assumed correct.` },
    { key: "open_exceptions", label: "Open exceptions", value: exceptions.filter((item) => !["resolved", "closed"].includes(item.status)).length, unit: "count", detail: "Synthetic exception queue." },
    { key: "outstanding_kobo", label: "Outstanding due value", value: dueItems.reduce((sum, item) => sum + Number(item.data.outstandingKobo ?? item.amountKobo), 0), unit: "kobo", detail: "Due items only; we never hold money." },
  ];

  const period = String(state.settings.billingPeriod || monthOf(now));
  // Commercial prospects are evidence, not additional subscriptions on this tenant.
  const commercial = recordsOf(state, "commercial").filter((item) => item.name===state.merchant.name&&item.data.designPartner===true&&item.data.signed&&String(item.data.effectiveDate||"").slice(0,7)<=period).slice(0,1);
  const reversalWindowDays = Number(state.settings.reversalWindowDays || 7);
  const billablePayments = payments.filter((item) => monthOf(item.createdAt) === period && paymentEligible(item, now, reversalWindowDays));
  const usageBase = billablePayments.reduce((sum, item) => sum + Number(item.data.allocatedKobo || item.amountKobo), 0);
  const usageFeeKobo = billablePayments.reduce((sum, item) => {
    const collected = Number(item.data.allocatedKobo || item.amountKobo);
    return sum + Math.min(15_000, Math.floor((collected * 30) / 10_000));
  }, 0);
  const lines = commercial.map((item) => {
    const designDiscount = item.data.designPartner === true && period.startsWith("2027") ? 0.5 : 1;
    const usage = Math.floor(usageFeeKobo * designDiscount);
    const licence = Math.floor(Number(item.data.licenceKobo || 0) * designDiscount);
    return { commercialId: item.id, prospect: item.name, implementationKobo: 0, licenceKobo: licence, usageKobo: usage, totalKobo: licence + usage, designPartnerDiscount: designDiscount < 1 };
  });
  const billing = {
    period, usageRateBps: 30, usageCapKobo: 15_000, reversalWindowDays,
    eligibleAllocatedKobo: usageBase, successfulCollections: billablePayments.length, lines, totalKobo: lines.reduce((sum, line) => sum + line.totalKobo, 0),
    implementationExcludedFromRecurring: true, synthetic: true,
  };

  const experiments = recordsOf(state, "experiments").filter((item) => item.status === "preregistered" || item.status === "closed");
  const experimentRows = experiments.map((experiment) => {
    const enrolled = dueItems.filter((due) => due.data.experimentId === experiment.id);
    const arms = { engine: enrolled.filter((d) => d.data.experimentArm === "engine"), holdout: enrolled.filter((d) => d.data.experimentArm === "holdout") };
    const matured=(due:ValopayRecord)=>Date.parse(now)>=Date.parse(String(due.data.firstFailureAt||due.createdAt))+30*DAY_MS;
    const rate = (items: ValopayRecord[]) => {
      const completed=items.filter(matured);
      const denominator=completed.reduce((s,d)=>s+d.amountKobo,0);
      const numerator=completed.reduce((sum,due)=>{
        const start=Date.parse(String(due.data.firstFailureAt||due.createdAt)),end=start+30*DAY_MS;
        const recovered=allocations.filter(a=>a.status==="confirmed"&&a.data.dueItemId===due.id).reduce((total,a)=>{
          const payment=payments.find(p=>p.id===a.data.paymentId);
          if(!payment||payment.data.settlementStatus!=="settled"||payment.data.reversalStatus==="reversed"||payment.data.refundStatus==="refunded")return total;
          const settled=Date.parse(payment.data.settledAt||payment.createdAt);
          return settled>=start&&settled<=end?total+a.amountKobo:total;
        },0);
        return sum+Math.min(due.amountKobo,recovered);
      },0);
      return denominator?numerator/denominator:0;
    };
    const min = Number(experiment.data.minPerArm || 0);
    return { experimentId: experiment.id, engine: arms.engine.length, holdout: arms.holdout.length, matureEngine:arms.engine.filter(matured).length,matureHoldout:arms.holdout.filter(matured).length,engineRecoveryByValue: rate(arms.engine), holdoutRecoveryByValue: rate(arms.holdout), minimumPerArm: min,confidenceInterval90:null,result: "not_proven", reason: arms.engine.filter(matured).length < min || arms.holdout.filter(matured).length < min ? "Insufficient mature 30-day outcomes per preregistered arm." : "Synthetic results cannot establish a recovery claim; independent inference validation is required.", synthetic: true };
  });
  return {
    metrics,
    billing,
    experiment: { results: experimentRows, result: "not_proven", synthetic: true },
    operational: {
      allocationRate, precision,
      certainAutomaticRate:payments.length?new Set(allocations.filter(a=>a.status==="confirmed"&&a.data.automatic===true&&a.data.confidence==="certain").map(a=>a.data.paymentId)).size/payments.length:0,
      reviewedCount:reviewed.length,falseMatchRate:reviewed.length?1-precision:null,requiredAuditSample:Math.min(200,allocations.filter(a=>a.status==="confirmed").length),
      overdueExceptionRate:exceptions.filter(e=>!["resolved","closed"].includes(e.status)).length?exceptions.filter(e=>!["resolved","closed"].includes(e.status)&&Date.parse(e.data.dueBy)<Date.parse(now)).length/exceptions.filter(e=>!["resolved","closed"].includes(e.status)).length:0,
      liveDays:0,requiredLiveDays:60,realCasesUsed:0,requiredRealCases:5,fortnightlyStaffConfirmed:false,monthEndCloseBusinessDays:null,
      unallocatedOlderThan24Hours: unallocated.filter((item) => Date.parse(now) - Date.parse(item.createdAt) >= DAY_MS).length, proof: false, reason: "All measurements are synthetic and are not operational proof."
    },
    closes: closeRecords,
  };
}