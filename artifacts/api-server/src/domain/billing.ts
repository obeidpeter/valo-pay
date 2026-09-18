/**
 * Billing of merchants (TRD 5.15).  BIL-01 decides what is billable, BIL-02
 * prices it, BIL-04 issues a monthly invoice net of VAT with VAT shown and a
 * statement of the collections counted, and BIL-07 corrects a billed
 * collection with a credit or debit line on the next invoice, never by editing
 * an issued one.  The recovery fee (BIL-03) stays behind its gate.
 */
import {
  counted,
  DEFAULT_REVERSAL_WINDOW_DAYS, DEFAULT_VAT_BPS, DESIGN_PARTNER_DISCOUNT, DESIGN_PARTNER_DISCOUNT_YEAR, RECOVERY_FEE_KOBO, USAGE_FEE_BPS, USAGE_FEE_CAP_KOBO,
  billableChannels, experimentRules, isBillableChannel, licenceTierFor, usageFeeKobo, vatKobo, type AdjustmentReason,
} from "@workspace/valopay-schema";
import { makeRecord, recordsOf } from "./records";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { paymentObservedAt, paymentRefunded, paymentReversed } from "./reconciliation";
import { attemptTime } from "./policy-engine";

const DAY_MS = 24 * 60 * 60 * 1000;
export const monthOf = (value: string): string => value.slice(0, 7);
const naira = (kobo: number): string => `NGN ${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The calendar month before the one containing `now`, the default invoice period. */
export function previousMonth(now: string): string {
  const current = new Date(now);
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1) - DAY_MS).toISOString().slice(0, 7);
}
/** Last instant of a YYYY-MM period. */
export function periodEnd(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 1) - 1).toISOString();
}

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
export function billableCollection(state: DomainState, payment: TypedRecord<"payments">, now: string, checkWindow = true): boolean {
  if (!isBillableChannel(payment.data.channel) || payment.data.collectionStatus !== "succeeded") return false;
  if (!["allocated", "overpaid", "partial"].includes(payment.status) || payment.data.settlementStatus !== "settled") return false;
  if (paymentReversed(payment) || paymentRefunded(payment)) return false;
  return !checkWindow || Date.parse(now) - paymentObservedAt(payment) >= reversalWindowDays(state, payment.data.providerConnection || state.merchant.provider) * DAY_MS;
}

export function vatBpsFor(state: DomainState): number {
  const configured = Number(state.settings.vatBps);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_VAT_BPS;
}

const issuedInvoices = (state: DomainState): TypedRecord<"invoices">[] =>
  recordsOf(state, "invoices").filter((item) => item.status === "issued").sort((a, b) => String(a.data.period).localeCompare(String(b.data.period)) || String(a.data.issuedAt).localeCompare(String(b.data.issuedAt)));

function confirmedDuplicate(state: DomainState, payment: TypedRecord<"payments">): boolean {
  return payment.status === "possible_duplicate" || recordsOf(state, "exceptions").some((item) => item.data.linkedRecordId === payment.id && item.data.type === "suspected_duplicate" && item.data.resolutionCode === "confirmed_duplicate_refund");
}

/** What a collection that was already billed is worth today: its usage fee, or nothing with the reason it is no longer billable. */
export function collectionFeeNow(state: DomainState, payment: TypedRecord<"payments">): { feeKobo: number; allocatedKobo: number; reason: AdjustmentReason | null } {
  const allocatedKobo = Number(payment.data.allocatedKobo || 0);
  if (paymentReversed(payment)) return { feeKobo: 0, allocatedKobo, reason: "reversal" };
  if (paymentRefunded(payment)) return { feeKobo: 0, allocatedKobo, reason: "refund" };
  if (confirmedDuplicate(state, payment)) return { feeKobo: 0, allocatedKobo, reason: "confirmed_duplicate" };
  // The reversal window was already respected when the collection was first billed.
  if (!billableCollection(state, payment, payment.updatedAt, false) || allocatedKobo <= 0) return { feeKobo: 0, allocatedKobo, reason: "wrong_allocation" };
  return { feeKobo: usageFeeKobo(allocatedKobo), allocatedKobo, reason: null };
}

interface LedgerEntry { netFeeKobo: number; allocatedKobo: number; originalInvoiceId: string; originalInvoiceReference: string; invoiceIds: string[] }

/** Net usage fee billed so far per collection across every issued invoice: usage lines plus later adjustment lines. */
export function billedLedger(state: DomainState): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  for (const invoice of issuedInvoices(state)) {
    for (const line of (invoice.data.usageLines || []) as Array<{ paymentId: string; feeKobo: number; allocatedKobo: number }>) {
      const entry = ledger.get(line.paymentId) ?? { netFeeKobo: 0, allocatedKobo: 0, originalInvoiceId: invoice.id, originalInvoiceReference: invoice.reference, invoiceIds: [] };
      entry.netFeeKobo += Number(line.feeKobo || 0); entry.allocatedKobo = Number(line.allocatedKobo || 0); entry.invoiceIds.push(invoice.id);
      ledger.set(line.paymentId, entry);
    }
    for (const line of (invoice.data.adjustments || []) as Array<{ paymentId: string; kobo: number; currentAllocatedKobo?: number }>) {
      const entry = ledger.get(line.paymentId) ?? { netFeeKobo: 0, allocatedKobo: 0, originalInvoiceId: invoice.id, originalInvoiceReference: invoice.reference, invoiceIds: [] };
      entry.netFeeKobo += Number(line.kobo || 0); if (line.currentAllocatedKobo !== undefined) entry.allocatedKobo = Number(line.currentAllocatedKobo); entry.invoiceIds.push(invoice.id);
      ledger.set(line.paymentId, entry);
    }
  }
  return ledger;
}

/** A recovery fee line (BIL-05): one per obligation the engine recovered inside the 30-day window, billed once. */
export interface RecoveryFeeLine {
  dueItemId: string;
  reference: string;
  attemptId: string;
  firstFailureAt?: string;
  windowClosedAt: string;
  feeKobo: number;
}

export interface AdjustmentLine {
  reason: AdjustmentReason;
  paymentId: string;
  paymentReference: string;
  originalInvoiceId: string;
  originalInvoiceReference: string;
  /** Negative for a credit, positive for a debit. */
  kobo: number;
  billedFeeKobo: number;
  currentFeeKobo: number;
  billedAllocatedKobo: number;
  currentAllocatedKobo: number;
  allocationIds: string[];
  explanation: string;
}

const reasonText: Record<AdjustmentReason, string> = {
  reversal: "was reversed by the provider after it was billed",
  refund: "was refunded to the customer after it was billed",
  confirmed_duplicate: "was confirmed as a duplicate after it was billed",
  wrong_allocation: "had its allocation superseded as a wrong match after it was billed",
  re_allocation: "was re-allocated at a higher value after it was billed",
};

/**
 * BIL-07: for every collection billed on an issued invoice, the difference
 * between what it is worth today and what has been billed net so far.  A
 * reversal, refund, confirmed duplicate or superseded allocation credits the
 * fee; a re-allocation at a higher value debits the difference.  Computed from
 * the ledger, so it is idempotent and never touches an issued invoice.
 */
export function pendingAdjustments(state: DomainState): AdjustmentLine[] {
  const lines: AdjustmentLine[] = [];
  const payments = new Map(recordsOf(state, "payments").map((item) => [item.id, item]));
  for (const [paymentId, entry] of billedLedger(state)) {
    const payment = payments.get(paymentId);
    if (!payment) continue;
    const fee = collectionFeeNow(state, payment);
    const kobo = fee.feeKobo - entry.netFeeKobo;
    if (kobo === 0) continue;
    const reason: AdjustmentReason = kobo > 0 ? "re_allocation" : (fee.reason ?? "wrong_allocation");
    lines.push({
      reason, paymentId, paymentReference: payment.reference, originalInvoiceId: entry.originalInvoiceId, originalInvoiceReference: entry.originalInvoiceReference, kobo,
      billedFeeKobo: entry.netFeeKobo, currentFeeKobo: fee.feeKobo, billedAllocatedKobo: entry.allocatedKobo, currentAllocatedKobo: fee.allocatedKobo,
      allocationIds: recordsOf(state, "allocations").filter((item) => item.data.paymentId === paymentId).map((item) => item.id),
      explanation: `Collection ${payment.reference} (${naira(entry.allocatedKobo)} billed ${naira(entry.netFeeKobo)} on ${entry.originalInvoiceReference}) ${reasonText[reason]}; ${kobo < 0 ? "credit" : "debit"} of ${naira(Math.abs(kobo))}.`,
    });
  }
  return lines.sort((a, b) => a.paymentReference.localeCompare(b.paymentReference));
}

/** BIL-03: the recovery fee, billed only after the 30-day window closes and only when the gate is open. */
export function recoveryFeeLines(state: DomainState, period: string) {
  const enabled = state.settings.recoveryFeeEnabled === true && state.settings.recoveryFeeDecision === "proven";
  const note = enabled
    ? `NGN ${RECOVERY_FEE_KOBO / 100} per recovered failed debit in the engine arm, billed once its ${experimentRules.outcomeWindowDays}-day window has closed, so a reversal inside the window never needs a credit.`
    : "Recovery fee is off: BIL-03 switches it on only when the Test 2 decision is recorded as proven (settings.recoveryFeeDecision) and settings.recoveryFeeEnabled is true.";
  if (!enabled) return { enabled, lines: [] as RecoveryFeeLine[], kobo: 0, note };
  const end = Date.parse(periodEnd(period));
  const billed = new Set(issuedInvoices(state).flatMap((invoice) => ((invoice.data.recoveryFee?.lines || []) as Array<{ dueItemId: string }>).map((line) => line.dueItemId)));
  const lines = recordsOf(state, "due-items").flatMap((due) => {
    if (due.data.experimentArm !== "engine" || !due.data.firstFailureAt || billed.has(due.id) || due.status !== "paid") return [];
    const start = Date.parse(String(due.data.firstFailureAt)), close = start + experimentRules.outcomeWindowDays * DAY_MS;
    if (close > end) return []; // the window has not closed by the invoice period end
    const retry = recordsOf(state, "attempts").find((attempt) => attempt.data.dueItemId === due.id && attempt.data.source === "valo" && attempt.status === "succeeded" && Date.parse(attemptTime(attempt)) >= start && Date.parse(attemptTime(attempt)) <= close);
    if (!retry) return []; // recovered by another channel, not under an engine-scheduled retry
    return [{ dueItemId: due.id, reference: due.reference, attemptId: retry.id, firstFailureAt: due.data.firstFailureAt, windowClosedAt: new Date(close).toISOString(), feeKobo: RECOVERY_FEE_KOBO }];
  });
  return { enabled, lines, kobo: lines.reduce((sum, line) => sum + line.feeKobo, 0), note };
}

/** The signed design-partner terms that price this merchant, if any; prospects are evidence, not subscriptions. */
function signedTerms(state: DomainState, period: string): TypedRecord<"commercial"> | undefined {
  return recordsOf(state, "commercial").find((item) => item.name === state.merchant.name && item.data.designPartner === true && item.data.signed && String(item.data.effectiveDate || "").slice(0, 7) <= period);
}
const designDiscountFor = (terms: TypedRecord<"commercial"> | undefined, period: string): number => terms?.data.designPartner === true && period.startsWith(DESIGN_PARTNER_DISCOUNT_YEAR) ? DESIGN_PARTNER_DISCOUNT : 1;

/** The monthly statement for the console and the billing export: what the period's receipts are worth and what the next invoice will carry. */
export function buildBillingStatement(state: DomainState, now: string): Record<string, any> {
  const payments = recordsOf(state, "payments");
  const period = String(state.settings.billingPeriod || monthOf(now));
  const terms = signedTerms(state, period);
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
  const lines = terms ? [(() => {
    const designDiscount = designDiscountFor(terms, period);
    const usage = Math.floor(usageFee * designDiscount);
    const contractedLicence = Number(terms.data.licenceKobo || 0);
    const licence = Math.floor(contractedLicence * designDiscount);
    return { commercialId: terms.id, prospect: terms.name, implementationKobo: 0, licenceKobo: licence, contractedLicenceKobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, usageKobo: usage, totalKobo: licence + usage, designPartnerDiscount: designDiscount < 1 };
  })()] : [];
  const invoices = issuedInvoices(state).map((invoice) => ({
    id: invoice.id, reference: invoice.reference, period: invoice.data.period, issuedAt: invoice.data.issuedAt, issuedBy: invoice.data.issuedBy, collectionsCounted: invoice.data.collectionsCounted,
    usageKobo: invoice.data.subtotals?.usageKobo, licenceKobo: invoice.data.subtotals?.licenceKobo, adjustmentsKobo: invoice.data.subtotals?.adjustmentsKobo, adjustmentCount: (invoice.data.adjustments || []).length,
    netKobo: invoice.data.totals?.netKobo, vatKobo: invoice.data.totals?.vatKobo, totalKobo: invoice.data.totals?.totalKobo, creditNote: invoice.data.totals?.creditNote === true,
  }));
  const adjustments = pendingAdjustments(state);
  return {
    period, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO, reversalWindowDays: reversalWindowDays(state, state.merchant.provider), vatBps: vatBpsFor(state),
    billableChannels: [...billableChannels], billableRule: "BIL-01: a collection is billable when its direct-debit attempt succeeded, the Payment is settled and unreversed at the invoice date, and the provider's reversal window has passed.",
    eligibleAllocatedKobo: usageBase, successfulCollections: billablePayments.length, usageFeeKobo: usageFee, volumeTier: tier.name,
    channelBreakdown, withheldInsideReversalWindow: withheld.length,
    lines, totalKobo: lines.reduce((sum, line) => sum + line.totalKobo, 0),
    invoices, nextInvoicePeriod: invoices.length ? nextPeriodAfter(String(invoices.at(-1)!.period)) : previousMonth(now),
    pendingAdjustments: adjustments, pendingAdjustmentsKobo: adjustments.reduce((sum, line) => sum + line.kobo, 0),
    adjustmentRule: "BIL-07: a reversal, refund, confirmed duplicate or superseded allocation affecting a billed collection is a credit or debit line on the next invoice with the references; issued invoices are never edited.",
    recoveryFee: recoveryFeeLines(state, period).note,
    implementationExcludedFromRecurring: true, synthetic: true,
  };
}

function nextPeriodAfter(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7);
}

/**
 * BIL-04: issue the invoice for a period as an immutable record: the licence
 * from the signed terms, one usage line per billable collection not billed
 * before and observed by the period end (so a collection withheld inside its
 * reversal window is billed on the next invoice), the design-partner discount,
 * the BIL-07 adjustment lines, the gated recovery fee, then VAT on the net.
 */
export function issueInvoice(state: DomainState, ctx: Context, input: { period?: unknown }): TypedRecord<"invoices"> {
  const now = ctx.now;
  const period = input.period ? String(input.period) : previousMonth(now);
  if (!/^\d{4}-\d{2}$/.test(period) || Number.isNaN(Date.parse(`${period}-01T00:00:00Z`))) throw new Error("data.period must be a calendar month as YYYY-MM.");
  if (period > monthOf(now)) throw new Error("An invoice cannot be issued for a future period.");
  const existing = issuedInvoices(state);
  const duplicate = existing.find((invoice) => invoice.data.period === period);
  if (duplicate) throw new Error(`Invoice ${duplicate.reference} for ${period} is already issued; a correction is an adjustment line on the next invoice (BIL-07).`);
  const latest = existing.at(-1);
  if (latest && String(latest.data.period) > period) throw new Error(`Invoices are issued in period order; ${latest.reference} already covers ${latest.data.period}.`);
  const end = Date.parse(periodEnd(period));
  const ledger = billedLedger(state);
  const usageLines = recordsOf(state, "payments")
    .filter((payment) => !ledger.has(payment.id) && paymentObservedAt(payment) <= end && billableCollection(state, payment, now))
    .sort((a, b) => paymentObservedAt(a) - paymentObservedAt(b) || a.reference.localeCompare(b.reference))
    .map((payment) => ({ paymentId: payment.id, paymentReference: payment.reference, customerId: payment.customerId, channel: payment.data.channel, observedAt: payment.data.observedAt || payment.createdAt, settledAt: payment.data.settledAt ?? null, allocatedKobo: Number(payment.data.allocatedKobo || 0), feeKobo: usageFeeKobo(Number(payment.data.allocatedKobo || 0)), allocationIds: recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").map((item) => item.id) }));
  const adjustments = pendingAdjustments(state);
  const recoveryFee = recoveryFeeLines(state, period);
  const terms = signedTerms(state, period);
  const tier = licenceTierFor(usageLines.length);
  const contractedLicence = Number(terms?.data.licenceKobo || 0);
  const designDiscount = designDiscountFor(terms, period);
  const usageKobo = usageLines.reduce((sum, line) => sum + line.feeKobo, 0);
  const adjustmentsKobo = adjustments.reduce((sum, line) => sum + line.kobo, 0);
  const discountBase = contractedLicence + usageKobo + adjustmentsKobo;
  const discountKobo = designDiscount < 1 ? -Math.floor(discountBase * (1 - designDiscount)) : 0;
  const netKobo = contractedLicence + usageKobo + adjustmentsKobo + discountKobo + recoveryFee.kobo;
  const vatBps = vatBpsFor(state);
  const vat = Math.trunc((netKobo * vatBps) / 10_000);
  const totalKobo = netKobo + vat;
  const sequence = existing.length + 1;
  return makeRecord(state, "invoices", {
    name: `Invoice ${period}`, status: "issued", reference: `INV-${period}-${String(sequence).padStart(3, "0")}`, amountKobo: Math.max(0, totalKobo), createdAt: now,
    data: {
      period, periodEnd: new Date(end).toISOString(), issuedAt: now, issuedBy: ctx.actor, sequence,
      terms: terms ? { commercialId: terms.id, prospect: terms.name, contractedLicenceKobo: contractedLicence, designPartner: terms.data.designPartner === true, effectiveDate: terms.data.effectiveDate ?? null } : null,
      licence: { kobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, note: terms ? "Contracted monthly licence from the signed terms; the tier for this month's count is shown for comparison." : "No signed terms: no licence is billed." },
      usageLines, collectionsCounted: usageLines.length, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO,
      designPartnerDiscount: { rate: 1 - designDiscount, kobo: discountKobo, note: designDiscount < 1 ? `Design-partner discount of ${Math.round((1 - designDiscount) * 100)}% in ${DESIGN_PARTNER_DISCOUNT_YEAR}; full public price from 1 January ${Number(DESIGN_PARTNER_DISCOUNT_YEAR) + 1}.` : "Full public price." },
      adjustments, recoveryFee,
      subtotals: { licenceKobo: contractedLicence, usageKobo, adjustmentsKobo, discountKobo, recoveryKobo: recoveryFee.kobo },
      totals: { netKobo, vatBps, vatKobo: vat, totalKobo, creditNote: totalKobo < 0 },
      statement: `${counted(usageLines.length, "collection")} counted at ${USAGE_FEE_BPS / 100}% capped at ${naira(USAGE_FEE_CAP_KOBO)}; ${counted(adjustments.length, "adjustment line")}; VAT at ${vatBps / 100}% shown separately.`,
      disputeRoute: "Dispute a count by raising it with your Valo Pay contact quoting the invoice reference and the collection reference; the count is derived from records and reproducible (BIL-01).",
      synthetic: true,
    },
  });
}
