// Golden tests for invoicing (BIL-04) and post-invoice adjustments (BIL-07)
// against TRD v1.1 section 5.15, with the recovery fee gate (BIL-03).
import assert from "node:assert/strict";
import { ctxAt, wat } from "./helpers.js";
import { executeAction } from "../src/domain/actions.js";
import { buildReports } from "../src/domain/reports.js";
import { issueInvoice, pendingAdjustments, previousMonth, periodEnd } from "../src/domain/billing.js";
import { supersedeAllocation } from "../src/domain/reconciliation.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { DomainState, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
let checks = 0;
const finance = (now: string) => ctxAt(now, "Finance");
const LICENCE = 60_000_000; // contracted Scale licence in the seed
const invoiceFor = (state: DomainState, period: string, now: string) => executeAction(state, finance(now), { action: "issue_invoice", reason: "month end", data: { period } }).record!;

function fixture(id: string): { state: DomainState; collection: (reference: string, observedAt: string, amountKobo?: number) => ValopayRecord } {
  const state = seedMerchant(id);
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true; terms.data.effectiveDate = "2027-01-01";
  // The seeded receipts become transfers so only the collections each case creates are billable (BIL-01 is covered in measurement-golden).
  for (const payment of recordsOf(state, "payments")) payment.data.channel = "transfer";
  const customer = recordsOf(state, "customers")[0]!;
  const collection = (reference: string, observedAt: string, amountKobo = 2_500_000) => {
    const due = makeRecord(state, "due-items", { name: `due ${reference}`, status: "paid", customerId: customer.id, amountKobo, reference: `DUE-${reference}`, data: { dueDate: observedAt.slice(0, 10), owner: "lms", outstandingKobo: 0 } });
    const payment = makeRecord(state, "payments", { name: reference, status: "allocated", customerId: customer.id, amountKobo, reference, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", observedAt, settledAt: observedAt, reversalStatus: "none", refundStatus: "none", allocatedKobo: amountKobo, dueItemId: due.id } });
    makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
    return payment;
  };
  return { state, collection };
}

// ---------- Helpers ----------
assert.equal(previousMonth("2027-07-01T09:00:00.000Z"), "2027-06");
assert.equal(previousMonth("2027-01-15T09:00:00.000Z"), "2026-12");
assert.equal(periodEnd("2027-06"), "2027-06-30T23:59:59.999Z");
checks += 3;

// ---------- BIL-04: the first invoice: licence from the signed terms, one usage line per billable collection, discount, VAT shown ----------
{
  const { state, collection } = fixture("invoice-first");
  const paid = collection("PSK-1", wat("2027-06-10T06:20:00"));
  collection("PSK-2", wat("2027-06-28T06:20:00")); // inside the seven-day reversal window at the invoice date
  const invoice = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(invoice.kind, "invoices"); assert.equal(invoice.status, "issued"); assert.equal(invoice.reference, "INV-2027-06-001");
  assert.equal(invoice.data.collectionsCounted, 1, "the collection still inside its reversal window is not counted");
  assert.equal(invoice.data.usageLines[0].paymentId, paid.id);
  assert.equal(invoice.data.usageLines[0].feeKobo, 7_500, "0.3% of NGN 25,000");
  assert.equal(invoice.data.licence.kobo, LICENCE, "the contracted licence is billed");
  assert.equal(invoice.data.licence.tierMismatch, true, "one collection is the entry tier; the contract governs and the mismatch is shown");
  assert.equal(invoice.data.designPartnerDiscount.kobo, -Math.floor((LICENCE + 7_500) / 2), "50% design-partner discount in 2027");
  const net = LICENCE + 7_500 - Math.floor((LICENCE + 7_500) / 2);
  assert.equal(invoice.data.totals.netKobo, net);
  assert.equal(invoice.data.totals.vatBps, 750);
  assert.equal(invoice.data.totals.vatKobo, Math.trunc(net * 0.075), "VAT at 7.5% shown separately");
  assert.equal(invoice.data.totals.totalKobo, net + Math.trunc(net * 0.075));
  assert.equal(invoice.amountKobo, invoice.data.totals.totalKobo);
  assert.equal(invoice.data.adjustments.length, 0);
  assert.equal(invoice.data.recoveryFee.enabled, false, "BIL-03: the recovery fee is gated off");
  assert.match(invoice.data.recoveryFee.note, /recorded as proven/);
  assert.throws(() => invoiceFor(state, "2027-06", wat("2027-07-02T09:00:00")), /already issued/, "one invoice per period; corrections are adjustment lines");
  assert.throws(() => invoiceFor(state, "2027-05", wat("2027-07-02T09:00:00")), /period order/);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "2027-08" }), /future period/);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "June" }), /YYYY-MM/);
  assert.throws(() => executeAction(state, ctxAt(wat("2027-07-02T09:00:00"), "Operations"), { action: "issue_invoice", reason: "x", data: { period: "2027-07" } }), /not permitted/);
  checks += 20;

  // The withheld collection is billed on the next invoice once its window has passed; the issued invoice is immutable.
  const next = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(next.reference, "INV-2027-07-002");
  assert.equal(next.data.collectionsCounted, 1);
  assert.equal(next.data.usageLines[0].paymentReference, "PSK-2", "billed once, on the first invoice after its reversal window closed");
  const before = structuredClone(state);
  invoice.data.totals.totalKobo = 1;
  assert.throws(() => assertFinalState(before, state, state.merchant.id), /immutable/, "issued invoices are never edited");
  invoice.data.totals.totalKobo = before.records.find((item) => item.id === invoice.id)!.data.totals.totalKobo;
  checks += 4;
}

// ---------- BIL-07: a reversal, a refund, a confirmed duplicate and a wrong allocation after billing are credit lines on the next invoice, with references ----------
{
  const { state, collection } = fixture("adjustments");
  const reversed = collection("PSK-R", wat("2027-06-05T06:20:00"));
  const refunded = collection("PSK-F", wat("2027-06-06T06:20:00"));
  const duplicate = collection("PSK-D", wat("2027-06-07T06:20:00"));
  const wrong = collection("PSK-W", wat("2027-06-08T06:20:00"));
  const untouched = collection("PSK-U", wat("2027-06-09T06:20:00"));
  const first = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(first.data.collectionsCounted, 5);
  assert.deepEqual(pendingAdjustments(state), [], "nothing to adjust right after issue");
  reversed.data.reversalStatus = "reversed";
  refunded.data.refundStatus = "refunded";
  makeRecord(state, "exceptions", { name: "dup", status: "resolved", customerId: duplicate.customerId, data: { type: "suspected_duplicate", linkedRecordId: duplicate.id, resolutionCode: "confirmed_duplicate_refund", owner: "Finance", severity: "medium" } });
  supersedeAllocation(state, finance(wat("2027-07-10T09:00:00")), recordsOf(state, "allocations").find((item) => item.data.paymentId === wrong.id)!, "Precision audit: wrong match");
  const pending = pendingAdjustments(state);
  assert.deepEqual(pending.map((line) => [line.paymentReference, line.reason, line.kobo]), [["PSK-D", "confirmed_duplicate", -7_500], ["PSK-F", "refund", -7_500], ["PSK-R", "reversal", -7_500], ["PSK-W", "wrong_allocation", -7_500]], "one credit per affected collection, the untouched one is not adjusted");
  assert.ok(pending.every((line) => line.originalInvoiceId === first.id && line.originalInvoiceReference === first.reference), "every line references the invoice it corrects");
  assert.match(pending[2]!.explanation, /PSK-R .*reversed by the provider.*credit of NGN 75\.00/);
  assert.ok(pending[3]!.allocationIds.length >= 1, "the superseded allocation is referenced");
  assert.equal(buildReports(state, wat("2027-07-15T09:00:00")).billing.pendingAdjustmentsKobo, -30_000, "the statement shows what the next invoice will carry");
  checks += 6;

  const second = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(second.data.adjustments.length, 4);
  assert.equal(second.data.subtotals.adjustmentsKobo, -30_000);
  assert.equal(second.data.collectionsCounted, 0, "no new collections in July");
  assert.equal(second.data.subtotals.licenceKobo, LICENCE);
  assert.equal(second.data.designPartnerDiscount.kobo, -Math.floor((LICENCE - 30_000) / 2), "the discount applies to the net of licence and adjustments");
  assert.equal(first.data.adjustments.length, 0, "the first invoice is untouched");
  assert.deepEqual(pendingAdjustments(state), [], "adjustments are billed once");
  checks += 7;

  // A wrong match re-allocated at a higher value is a debit line; re-allocated at the same value there is nothing to adjust.
  wrong.status = "allocated"; wrong.data.allocatedKobo = 4_000_000; wrong.amountKobo = 4_000_000;
  const debit = pendingAdjustments(state);
  assert.deepEqual(debit.map((line) => [line.paymentReference, line.reason, line.kobo]), [["PSK-W", "re_allocation", 12_000]], "usage on NGN 40,000 is NGN 120, nothing billed net so far");
  const third = invoiceFor(state, "2027-08", wat("2027-09-01T09:00:00"));
  assert.equal(third.data.subtotals.adjustmentsKobo, 12_000);
  assert.equal(third.data.adjustments[0].originalInvoiceReference, first.reference, "still references the invoice that first billed the collection");
  assert.deepEqual(pendingAdjustments(state), []);
  void untouched;
  checks += 4;

  // A credit note: adjustments larger than the month's charges give a negative net with negative VAT, never an edit to the issued invoice.
  const { state: creditState, collection: creditCollection } = fixture("credit-note");
  recordsOf(creditState, "commercial")[0]!.data.signed = false; // no licence
  const big = creditCollection("PSK-BIG", wat("2027-06-05T06:20:00"), 10_000_000);
  invoiceFor(creditState, "2027-06", wat("2027-07-01T09:00:00"));
  big.data.reversalStatus = "reversed";
  const note = invoiceFor(creditState, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(note.data.totals.netKobo, -15_000, "the capped NGN 150 fee is credited");
  assert.equal(note.data.totals.vatKobo, -1_125);
  assert.equal(note.data.totals.creditNote, true);
  assert.equal(note.amountKobo, 0, "record amounts stay non-negative; the credit is in the totals");
  checks += 4;
}

// ---------- BIL-03: the recovery fee is billed only after the 30-day window closes, engine arm only, and only when the gate is open ----------
{
  const { state } = fixture("recovery");
  const customer = recordsOf(state, "customers")[1]!;
  const due = makeRecord(state, "due-items", { name: "recovered", status: "paid", customerId: customer.id, amountKobo: 2_500_000, reference: "DUE-REC", data: { dueDate: "2027-06-01", owner: "valopay", outstandingKobo: 0, experimentArm: "engine", experimentId: "x", firstFailureAt: wat("2027-06-10T06:16:00") } });
  makeRecord(state, "attempts", { name: "retry", status: "succeeded", customerId: customer.id, amountKobo: 2_500_000, data: { dueItemId: due.id, number: 2, source: "valo", occurredAt: wat("2027-06-12T06:16:00") } });
  const gated = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(gated.data.recoveryFee.enabled, false);
  assert.equal(gated.data.subtotals.recoveryKobo, 0);
  state.settings.recoveryFeeEnabled = true;
  assert.equal(issueInvoice(structuredClone(state), finance(wat("2027-08-01T09:00:00")), { period: "2027-07" }).data.recoveryFee.enabled, false, "the flag alone does not open the gate");
  state.settings.recoveryFeeDecision = "proven";
  const july = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(july.data.recoveryFee.enabled, true);
  assert.equal(july.data.recoveryFee.lines.length, 1, "the window closed on 10 July, so July's invoice carries the fee, not June's");
  assert.equal(july.data.recoveryFee.lines[0].dueItemId, due.id);
  assert.equal(july.data.subtotals.recoveryKobo, 15_000);
  const august = invoiceFor(state, "2027-08", wat("2027-09-01T09:00:00"));
  assert.equal(august.data.recoveryFee.lines.length, 0, "billed once");
  checks += 8;
}

console.log(`Billing golden tests passed (${checks} checks): invoice lines, VAT, period rules, withheld collections, adjustment credits and debits with references, credit note, recovery fee gate and window.`);
