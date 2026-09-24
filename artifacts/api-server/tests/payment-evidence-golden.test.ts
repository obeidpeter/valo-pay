// Golden tests for payment evidence that names no payer, evidence that shares a
// provider reference, rule R1's currency and connection, rule R4's narration
// references, settlement batches with several statement credits or a line in
// two batches, the unapplied rest of a partly allocated payment and Finance's
// "distinct payments" resolution (23 September audit, items 1, 2, 4, 5, 6, 13
// and 14), and what the review of those fixes found: evidence through another
// connection name, a payer identified through a wrong match, a net line applied
// before the debit's gross, a gross below the amount received, money in another
// currency and a line an earlier build counted in two batches. Every request
// runs as the store runs it: on a copy, with the repository's final-state
// check, and rolled back when it is refused.
import assert from "node:assert/strict";
import { HOUR, addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, amendDueItem, paymentObservedAt, reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";
import { positionFor, positionMismatches } from "../src/domain/close.js";
import { connectedRevision, runConnectedAction } from "../src/domain/connected.js";
import { importCsv } from "../src/lib/valopay-import.js";
import { pageReconciliation } from "../src/lib/console-read-models.js";
import { paymentAwaitsAllocation, paymentRefundedKobo, paymentUnappliedKobo } from "@workspace/valopay-schema";
import type { DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
const finance = (now: string) => ctxAt(now, "Finance");
let checks = 0;
const failures: string[] = [];
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const equal = <T>(actual: T, expected: T, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

/** One finding's checks; a failure is reported with the others, so every finding is seen at once. */
function section(name: string, run: () => void) {
  try { run(); } catch (error) { failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`); }
}

/** A request as the store applies it: run on the lender, check the final state against the state before, and roll back when refused. */
function request<T>(state: DomainState, run: () => T): { ok: true; value: T } | { ok: false; message: string; status?: number } {
  const before = structuredClone(state);
  try {
    const value = run();
    assertFinalState(structuredClone(before), state, state.merchant.id, new Date().toISOString());
    return { ok: true, value };
  } catch (error) {
    state.records = before.records; state.settings = before.settings; state.merchant = before.merchant;
    return { ok: false, message: (error as Error).message, status: (error as { status?: number }).status };
  }
}
function accepted<T>(outcome: ReturnType<typeof request<T>>, label: string): T {
  if (!outcome.ok) assert.fail(`${label} was refused: ${outcome.message}`);
  checks += 1;
  return outcome.value;
}
/** Evidence as POST /v1/records/observations creates it: validated, unresolved, synthetic. */
function postObservation(state: DomainState, now: string, body: { reference: string; amountKobo: number; customerId?: string; data: Record<string, unknown> }) {
  const input: any = { ...body, name: body.reference, status: "unresolved", data: { ...body.data, synthetic: true }, createdAt: now, updatedAt: now };
  validateRecord(state, finance(now), "observations", input);
  return makeRecord(state, "observations", input) as TypedRecord<"observations">;
}
/** An instalment as POST /v1/records/due-items creates it. */
function postDue(state: DomainState, now: string, customerId: string, mandateId: string, reference: string, amountKobo: number, dueDate: string) {
  const input: any = { name: reference, reference, amountKobo, customerId, status: "scheduled", data: { dueDate, mandateId, owner: "lms", outstandingKobo: amountKobo, synthetic: true }, createdAt: now, updatedAt: now };
  validateRecord(state, ctxAt(now, "Admin"), "due-items", input);
  return makeRecord(state, "due-items", input) as TypedRecord<"due-items">;
}
const payment = (state: DomainState, reference: string) => recordsOf(state, "payments").filter((item) => item.reference === reference);
const allocationsOf = (state: DomainState, paymentId: string) => recordsOf(state, "allocations").filter((item) => item.data.paymentId === paymentId);
const exceptionsFor = (state: DomainState, linkedRecordId: string, type?: string) => recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === linkedRecordId && (!type || item.data.type === type));
const close = (state: DomainState, at: string) => accepted(request(state, () => executeAction(state, finance(wat(at)), { action: "daily_close" })), `the daily close at ${at} WAT`).record!;

// ---------- Item 1: evidence with no payer is applied only when Finance identifies the payer, in the same action ----------
section("a settlement line with no customer", () => {
  const { state, due: fixtureDue } = liveFixture({ withFailure: false, merchantId: "no-payer-settlement" });
  addAttempt(state, fixtureDue, { status: "sent", occurredAt: wat("2027-07-01T06:15:00"), providerReference: "PSK-NOCUST-1" });
  // The provider's settlement report as the importer receives it: no lender customer column.
  const csv = "reference,amount,grossAmountKobo,feeKobo,batchReference,source,eventId,occurredAt\nPSK-NOCUST-1,24875.00,25000.00,125.00,B-0702,settlement,line-1,2027-07-02T06:00:00Z";
  accepted(request(state, () => importCsv(state, ctxAt(wat("2027-07-02T08:00:00"), "Operations"), { kind: "observations", csv, syntheticOnly: true, commit: true, amountUnit: "naira" })), "the settlement file");
  // A committed import replaces the lender's records with its checked copy.
  const due = recordsOf(state, "due-items").find((item) => item.id === fixtureDue.id)!;
  const first = close(state, "2027-07-02T09:00:00");
  close(state, "2027-07-03T07:00:00");
  const [received] = payment(state, "PSK-NOCUST-1");
  equal([received!.customerId, received!.status], ["", "proposed"], "the payment keeps no payer and waits for Finance");
  const [proposal] = allocationsOf(state, received!.id);
  equal([proposal!.status, proposal!.data.rule, proposal!.data.confidence, proposal!.data.automatic, proposal!.customerId], ["proposed", "R1", "probable", false, ""], "R1 proposes the match and never applies it");
  check(/names no payer/.test(String(proposal!.data.explanation)), "the proposal says why Finance must confirm it");
  equal([outstandingOf(due), due.status], [due.amountKobo, "scheduled"], "nothing is applied to the instalment yet");
  equal(first.data.report.proposed.count >= 1, true, "the close reports the proposal");
  // Finance confirms: the payer is identified in the same action, with who and why.
  const confirmed = accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T10:00:00")), { action: "confirm_allocation", recordId: received!.id, reason: "The debit reference is this customer's instalment." })), "Finance's confirmation");
  equal(received!.customerId, due.customerId, "the payment now carries the payer");
  equal([received!.data.payerIdentification?.customerId, received!.data.payerIdentification?.identifiedBy, received!.data.payerIdentification?.reason, received!.data.payerIdentification?.allocationId], [due.customerId, "Sandbox Finance", "The debit reference is this customer's instalment.", proposal!.id], "who identified the payer, and why, is on the payment");
  equal([proposal!.status, proposal!.customerId, due.status, outstandingOf(due)], ["confirmed", due.customerId, "paid", 0], "the confirmed match carries the payer and pays the instalment");
  check(/^Payer identified as customer DEMO-C1005 for payment PSK-NOCUST-1\.$/.test(String(confirmed.data.auditNote)) && /Ngozi Eze \(DEMO-C1005\)/.test(confirmed.message), "the answer names the payer and the audit entry says the payer was identified");
  close(state, "2027-07-04T07:00:00");
});

section("the seeded unidentified transfer", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "no-payer-manual" });
  const [unidentified] = payment(state, "SBX-UNIDENTIFIED-001");
  const outcome = accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: unidentified!.id, reason: "Payer confirmed by phone against the transfer narration.", data: { dueItemId: due.id, amountKobo: 1_000_000 } })), "the manual allocation of a payment with no payer");
  equal(unidentified!.customerId, due.customerId, "allocating it identifies the payer");
  equal([unidentified!.data.payerIdentification?.identifiedBy, unidentified!.data.payerIdentification?.reason, unidentified!.data.payerIdentification?.dueItemId], ["Sandbox Finance", "Payer confirmed by phone against the transfer narration.", due.id], "and records who did it and why");
  const allocation = outcome.record as TypedRecord<"allocations">;
  equal([allocation.status, allocation.customerId, allocation.data.rule], ["confirmed", due.customerId, "R7"], "the manual allocation is applied for that payer");
  check(/identified the payer/.test(String(allocation.data.explanation)), "the allocation explains the identification");
  check(outcome.data.auditNote === "Payer identified as customer DEMO-C1005 for payment SBX-UNIDENTIFIED-001.", "the audit entry says so, by customer reference");
  equal([unidentified!.status, paymentUnappliedKobo(unidentified!)], ["partial", 2_200_000], "the rest stays unapplied");
  // The payer is now known: another customer's instalment is refused with a reason, not by the repository.
  const other = recordsOf(state, "due-items").find((item) => item.customerId !== due.customerId && item.status === "scheduled")!;
  const refused = request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: unidentified!.id, reason: "Wrong payer", data: { dueItemId: other.id, amountKobo: 100_000 } }));
  check(!refused.ok && refused.status === 409 && /another customer/.test(refused.message), `another customer's instalment is refused with a reason (${!refused.ok && refused.message})`);
  // Automatic matching never identifies a payer.
  addObservation(state, { reference: "TRF-NOBODY", amountKobo: due.amountKobo, source: "transfer", eventId: "nobody", occurredAt: wat("2027-07-01T12:00:00") });
  reconcile(state, finance(wat("2027-07-01T12:05:00")));
  const [nobody] = payment(state, "TRF-NOBODY");
  const second = recordsOf(state, "due-items").find((item) => item.customerId === due.customerId && item.id !== due.id) ?? due;
  assert.throws(() => allocatePayment(state, finance(wat("2027-07-01T12:10:00")), nobody!, second, 100_000, "R1", "certain", true), /payer/); checks += 1;
  equal(nobody!.customerId, "", "and the payment keeps no payer");
});

// ---------- Item 2: evidence from two payers that shares a provider reference is never merged ----------
section("a second payer's evidence with the first payer's reference and an instalment link", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-link" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const t0 = wat("2027-07-01T10:00:00"), t1 = wat("2027-07-01T11:00:00");
  accepted(request(state, () => postObservation(state, t0, { reference: "TRF-20270701-0001", amountKobo: 700_000, customerId: a!.customerId, data: { source: "transfer", eventId: "bank-a-1", occurredAt: t0 } })), "A's transfer");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T10:05:00")))), "the first reconciliation");
  const second = accepted(request(state, () => postObservation(state, t1, { reference: "TRF-20270701-0001", amountKobo: b!.amountKobo, customerId: b!.customerId, data: { source: "card", eventId: "card-b-1", dueItemId: b!.id, occurredAt: t1 } })), "B's card payment");
  for (const at of ["2027-07-01T12:00:00", "2027-07-02T07:00:00"]) close(state, at);
  const [first] = payment(state, "TRF-20270701-0001");
  equal([payment(state, "TRF-20270701-0001").length, first!.customerId, first!.amountKobo, first!.data.dueItemId], [1, a!.customerId, 700_000, undefined], "A's payment keeps A's payer, amount and link");
  equal(second.status, "unresolved", "B's evidence is not merged into A's payment");
  const [held] = exceptionsFor(state, second.id, "suspected_duplicate");
  check(held && held.status === "open" && held.data.owner === "Finance" && /another payer/.test(String(held.data.notes)), "an exception asks Finance about the conflict");
  equal(exceptionsFor(state, second.id).length, 1, "and the next close does not raise it again");
  // Finance says the two are different payments: the next close records B's as a payment of its own.
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Two different payers; the provider reused the reference.", data: { resolutionCode: "distinct_payments" } })), "the resolution");
  close(state, "2027-07-02T10:00:00");
  const own = payment(state, "TRF-20270701-0001").find((item) => item.id !== first!.id)!;
  equal([second.status, second.data.paymentId, own.customerId, own.amountKobo], ["resolved", own.id, b!.customerId, b!.amountKobo], "B's evidence is now a payment of its own");
  equal([b!.status, allocationsOf(state, own.id)[0]?.data.rule], ["paid", "R1"], "and it pays B's instalment");
  equal(first!.status, "unallocated", "A's payment is untouched");
});

section("a second payer's evidence with the same reference and a different amount", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-amount" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const t0 = wat("2027-07-01T10:00:00");
  accepted(request(state, () => postObservation(state, t0, { reference: "TRF-0001", amountKobo: a!.amountKobo, customerId: a!.customerId, data: { source: "transfer", eventId: "bank-a-1", occurredAt: t0, narration: `pay ${a!.reference}` } })), "A's transfer");
  const cardB = accepted(request(state, () => postObservation(state, t0, { reference: "TRF-0001", amountKobo: 999_999, customerId: b!.customerId, data: { source: "card", eventId: "card-b-1", occurredAt: t0 } })), "B's card payment");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T10:05:00")))), "the reconciliation");
  equal(payment(state, "TRF-0001").map((item) => [item.customerId, item.amountKobo]), [[a!.customerId, a!.amountKobo]], "one payment, A's");
  equal(cardB.status, "unresolved", "B's ₦9,999.99 stays visible as unresolved evidence");
  const [held] = exceptionsFor(state, cardB.id, "suspected_duplicate");
  check(held && /another payer/.test(String(held.data.notes)) && held.amountKobo === 999_999, "with an exception for its money");
  // Finance confirms it duplicates the first payment and must be refunded: it is recorded, held, then refunded.
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Charged twice; refund the card payment.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "the resolution");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T11:05:00")))), "the next reconciliation");
  const own = payment(state, "TRF-0001").find((item) => item.customerId === b!.customerId)!;
  equal([own.status, own.amountKobo, allocationsOf(state, own.id).length], ["possible_duplicate", 999_999, 0], "the duplicate is a payment held for its refund, never applied");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T12:00:00")), { action: "record_refund", recordId: own.id, reason: "Refunded by the card provider.", data: { reference: "RF-***99" } })), "the refund");
  equal([own.status, paymentRefundedKobo(own)], ["returned", 999_999], "and its refund returns it");
});

section("evidence names the provider connection it came through", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-connection" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  addObservation(state, { reference: "REF-SHARED", amountKobo: 1_111_100, source: "transfer", customerId: a!.customerId, eventId: "shared-a", occurredAt: wat("2027-07-01T09:00:00") });
  const otherRail = addObservation(state, { reference: "REF-SHARED", amountKobo: 2_222_200, source: "transfer", customerId: b!.customerId, eventId: "shared-b", occurredAt: wat("2027-07-01T09:00:00"), provider: "Other Rail" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:05:00")))), "the reconciliation");
  // The review of these fixes: evidence through a connection where no payment has its reference, while another connection's payment does, waits for Finance.
  equal([payment(state, "REF-SHARED").map((item) => [item.data.providerConnection, item.customerId, item.amountKobo]), otherRail.status], [[["Sandbox Rail", a!.customerId, 1_111_100]], "unresolved"], "the reference through another connection is neither merged nor made a payment on its own");
  const [otherHeld] = exceptionsFor(state, otherRail.id, "suspected_duplicate");
  check(otherHeld && otherHeld.status === "open" && /came through Other Rail, where no payment has its reference/.test(String(otherHeld.data.notes)) && /observed through Sandbox Rail\./.test(String(otherHeld.data.notes)), `Finance is asked about it, with both connections named (${otherHeld?.data.notes})`);
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T09:07:00")), { action: "resolve_exception", recordId: otherHeld!.id, reason: "B paid through the other rail.", data: { resolutionCode: "distinct_payments" } })), "Finance's resolution");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:08:00")))), "the reconciliation after it");
  equal(payment(state, "REF-SHARED").map((item) => [item.data.providerConnection, item.customerId, item.amountKobo]).sort(), [["Other Rail", b!.customerId, 2_222_200], ["Sandbox Rail", a!.customerId, 1_111_100]].sort(), "once Finance says it is money of its own, the same reference through another connection is another payment");
  equal(recordsOf(state, "observations").filter((item) => item.reference === "REF-SHARED" && item.status !== "resolved").length, 0, "both are resolved");
  // Connection names are free text: the same connection written another way is the same key.
  const again = addObservation(state, { reference: "REF-SHARED", amountKobo: 1_111_100, source: "webhook", customerId: a!.customerId, eventId: "shared-a-2", occurredAt: wat("2027-07-01T09:10:00"), provider: " sandbox rail " } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:15:00")))), "the next reconciliation");
  equal([payment(state, "REF-SHARED").length, again.data.paymentId], [2, payment(state, "REF-SHARED").find((item) => item.customerId === a!.customerId)!.id], "evidence naming the lender's connection in other case joins its payment");
  // A settlement line that states only what it paid out, then the debit's own gross: one payment, at the gross.
  const { state: net, due } = liveFixture({ withFailure: false, merchantId: "net-then-gross" });
  addObservation(net, { reference: "PSK-NET", amountKobo: 2_487_500, batchReference: "B-NET", source: "settlement", customerId: due.customerId, eventId: "net-1", occurredAt: wat("2027-07-01T07:00:00") });
  accepted(request(net, () => reconcile(net, finance(wat("2027-07-01T07:05:00")))), "the settlement line");
  addObservation(net, { reference: "PSK-NET", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "gross-1", occurredAt: wat("2027-07-01T07:10:00") });
  accepted(request(net, () => reconcile(net, finance(wat("2027-07-01T07:15:00")))), "the webhook");
  equal([payment(net, "PSK-NET").length, payment(net, "PSK-NET")[0]!.amountKobo, recordsOf(net, "observations").filter((item) => item.reference === "PSK-NET" && item.status === "resolved").length], [1, 2_500_000, 2], "the webhook's gross agrees with the net line and completes the payment");
});

// ---------- Item 4: rule R1 compares the payment's real currency and connection ----------
section("rule R1's currency and connection", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "r1-currency" });
  const [other, third] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled" && item.id !== due.id);
  const t0 = wat("2027-07-01T07:00:00");
  addAttempt(state, due, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-1" });
  addAttempt(state, other!, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-2" });
  addAttempt(state, third!, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-3" });
  const post = (reference: string, target: TypedRecord<"due-items">, data: Record<string, unknown>) => postObservation(state, t0, { reference, amountKobo: target.amountKobo, customerId: target.customerId, data: { source: "card", eventId: reference, occurredAt: t0, ...data } });
  post("REF-XYZ-1", due, { provider: "Some Other Rail", providerConnection: "Some Other Rail", currency: "USD" });
  post("REF-XYZ-2", other!, { provider: "Some Other Rail", providerConnection: "Some Other Rail" });
  post("REF-XYZ-3", third!, {});
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:10:00")))), "the reconciliation");
  const [usd] = payment(state, "REF-XYZ-1"), [otherRail] = payment(state, "REF-XYZ-2"), [own] = payment(state, "REF-XYZ-3");
  equal([usd!.data.currency, usd!.data.providerConnection, usd!.status, allocationsOf(state, usd!.id).length, due.status], ["USD", "Some Other Rail", "unallocated", 0, "scheduled"], "a USD card payment on another rail is not applied");
  const [usdException] = exceptionsFor(state, usd!.id, "unallocated_payment");
  check(usdException && /USD/.test(String(usdException.data.notes)) && /Some Other Rail/.test(String(usdException.data.notes)), "and an exception says why");
  equal([otherRail!.status, allocationsOf(state, otherRail!.id).length, exceptionsFor(state, otherRail!.id, "unallocated_payment").length], ["unallocated", 0, 1], "a naira payment through another connection is held the same way");
  equal([own!.data.currency, own!.data.providerConnection, allocationsOf(state, own!.id)[0]?.data.rule, allocationsOf(state, own!.id)[0]?.data.automatic, third!.status], ["NGN", "Sandbox Rail", "R1", true, "paid"], "the lender's own naira evidence still matches with certainty");
  const refused = request(state, () => executeAction(state, finance(wat("2027-07-01T08:00:00")), { action: "manual_allocate", recordId: usd!.id, reason: "By hand", data: { dueItemId: due.id, amountKobo: due.amountKobo } }));
  check(!refused.ok && refused.status === 409 && /naira/.test(refused.message), "money in another currency cannot be applied to a naira instalment by hand either");
});

// ---------- Item 5: rule R4 reads instalment references on token boundaries ----------
section("rule R4's narration references", () => {
  const t0 = wat("2027-07-01T07:00:00");
  const run = (merchantId: string, arrange: (state: DomainState, customer: string, mandate: string) => void, narration: string, amountKobo = 2_500_000) => {
    const { state, customer, mandate, due } = liveFixture({ withFailure: false, merchantId });
    // The seed is dated from today: its instalment is moved clear of rule R5's window around the payment.
    due.data.dueDate = "2026-01-28";
    arrange(state, customer.id, mandate.id);
    addObservation(state, { reference: `TRF-${merchantId}`, amountKobo, source: "transfer", customerId: customer.id, eventId: merchantId, occurredAt: t0, narration });
    accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:10:00")))), `the reconciliation for ${merchantId}`);
    const [received] = payment(state, `TRF-${merchantId}`);
    const allocation = allocationsOf(state, received!.id)[0];
    return { state, received: received!, allocation, target: recordsOf(state, "due-items").find((item) => item.id === allocation?.data.dueItemId) };
  };
  const pair = (paid: boolean) => (state: DomainState, customer: string, mandate: string) => {
    postDue(state, t0, customer, mandate, "LN0042-1", 2_500_000, "2027-01-28");
    const tenth = postDue(state, t0, customer, mandate, "LN0042-10", 2_500_000, "2027-10-28");
    if (paid) { tenth.data.outstandingKobo = 0; tenth.status = "paid"; }
  };
  const paid = run("r4-paid", pair(true), "Loan LN0042-10 October instalment");
  equal(paid.allocation, undefined, "a narration naming the paid LN0042-10 is not applied to LN0042-1");
  const open = run("r4-open", pair(false), "LN0042-10");
  equal([open.target?.reference, open.allocation?.data.rule, open.allocation?.data.automatic], ["LN0042-10", "R4", true], "it names LN0042-10, not LN0042-1");
  const both = run("r4-both", pair(false), "LN0042-1 and LN0042-10");
  equal(both.allocation?.data.rule === "R4", false, "a narration naming two instalments is not matched automatically");
  const longest = run("r4-longest", (state, customer, mandate) => { postDue(state, t0, customer, mandate, "LN0077", 2_500_000, "2027-01-28"); postDue(state, t0, customer, mandate, "LN0077-10", 2_500_000, "2027-10-28"); }, "Payment for LN0077-10");
  equal(longest.target?.reference, "LN0077-10", "the longest reference wins where references overlap");
  const elsewhere = run("r4-elsewhere", (state, customer, mandate) => {
    postDue(state, t0, customer, mandate, "LN0099", 2_500_000, "2027-01-28");
    const someone = recordsOf(state, "customers").find((item) => item.id !== customer)!;
    const theirs = recordsOf(state, "mandates").find((item) => item.customerId === someone.id)!;
    postDue(state, t0, someone.id, theirs.id, "LN0099-5", 2_500_000, "2027-02-28");
  }, "LN0099-5");
  equal(elsewhere.allocation?.data.rule === "R4", false, "a narration naming another customer's LN0099-5 is not this payer's LN0099");
  const alike = run("r4-alike", (state, customer, mandate) => {
    postDue(state, t0, customer, mandate, "LN0055-2", 2_500_000, "2027-01-28");
    const someone = recordsOf(state, "customers").find((item) => item.id !== customer)!;
    const theirs = recordsOf(state, "mandates").find((item) => item.customerId === someone.id)!;
    postDue(state, t0, someone.id, theirs.id, "LN0055/2", 2_500_000, "2027-02-28");
  }, "LN0055-2");
  equal(alike.allocation?.data.rule === "R4", false, "a reference that is not unique across the lender is not matched automatically");
});

// ---------- Item 6: settlement batches keep every bank credit and count a collection once ----------
section("two statement credits for one batch", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "two-credits" });
  addObservation(state, { reference: "PSK-P2", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-P2", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s", occurredAt: wat("2027-07-01T07:00:00") });
  const creditA = addObservation(state, { reference: "STMT-A", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-a", occurredAt: wat("2027-07-02T07:00:00") });
  const creditB = addObservation(state, { reference: "STMT-B", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-b", occurredAt: wat("2027-07-02T07:05:00") });
  const repeat = addObservation(state, { reference: "STMT-A", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-a-again", occurredAt: wat("2027-07-02T07:10:00") });
  const report = close(state, "2027-07-02T09:00:00").data.report;
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-P2")!;
  equal([creditA.status, creditB.status, repeat.status], ["resolved", "resolved", "resolved"], "every credit resolves to the batch");
  equal([batch.data.statementNetKobo, batch.data.statementObservationId, batch.status], [4_975_000, creditA.id, "variance"], "the credits are summed, so the second one is a variance rather than a replacement");
  equal(repeat.data.duplicateStatementCredit, true, "the same bank line delivered again adds nothing");
  check(/2 statement credits/.test(String(batch.data.explanation)), "the explanation counts the credits");
  equal([report.variances.count, exceptionsFor(state, batch.id, "settlement_variance").length], [1, 1], "the close reports the variance and Finance has an exception");
  // Two credits that together pay the batch reconcile it.
  const { state: split, due: splitDue } = liveFixture({ withFailure: false, merchantId: "split-credits" });
  addObservation(split, { reference: "PSK-SPLIT", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-SP", source: "settlement", customerId: splitDue.customerId, dueItemId: splitDue.id, eventId: "s", occurredAt: wat("2027-07-01T07:00:00") });
  addObservation(split, { reference: "STMT-1", amountKobo: 1_000_000, batchReference: "B-SP", source: "statement", eventId: "st-1", occurredAt: wat("2027-07-02T07:00:00") });
  addObservation(split, { reference: "STMT-2", amountKobo: 1_487_500, batchReference: "B-SP", source: "statement", eventId: "st-2", occurredAt: wat("2027-07-02T07:05:00") });
  close(split, "2027-07-02T09:00:00");
  equal(recordsOf(split, "settlement-batches")[0]!.status, "reconciled", "two credits that sum to the net reconcile the batch");
});

section("one settlement line in two batches", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "line-in-two-batches" });
  addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s1", occurredAt: wat("2027-07-01T07:00:00") });
  const again = addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-2", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s2", occurredAt: wat("2027-07-02T07:00:00") });
  addObservation(state, { reference: "STMT-1", amountKobo: 2_487_500, batchReference: "B-1", source: "statement", eventId: "st1", occurredAt: wat("2027-07-02T08:00:00") });
  addObservation(state, { reference: "STMT-2", amountKobo: 2_487_500, batchReference: "B-2", source: "statement", eventId: "st2", occurredAt: wat("2027-07-02T08:00:00") });
  const report = close(state, "2027-07-02T09:00:00").data.report;
  const one = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-1")!, two = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-2")!;
  equal([one.status, one.data.grossKobo, two.data.grossKobo], ["reconciled", 2_500_000, 0], "the collection is counted in its first batch only");
  equal([again.status, again.data.duplicateSettlementLine, again.data.settlementBatchId, again.data.countedInBatchId], ["resolved", true, two.id, one.id], "the second line is evidence that names where it is counted");
  const [exception] = exceptionsFor(state, two.id, "settlement_variance");
  check(exception && /PSK-P3/.test(String(exception.data.notes)) && /B-1/.test(String(exception.data.notes)), "an exception says the line is already counted in B-1");
  equal([two.status, report.variances.batches.map((item: { reference: string }) => item.reference)], ["variance", ["B-2"]], "and the second batch's credit is a variance, not a second payout reconciled");
});

// ---------- Item 13: the unapplied rest of a partly allocated payment stays with Finance ----------
section("the rest of a partly allocated payment", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "partial-rest" });
  addObservation(state, { reference: "TRF-P1", amountKobo: 5_000_000, source: "transfer", customerId: due.customerId, eventId: "p1", occurredAt: wat("2027-07-01T10:00:00") });
  close(state, "2027-07-01T10:05:00");
  const [received] = payment(state, "TRF-P1");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Part of it is for this instalment.", data: { dueItemId: due.id, amountKobo: 1_000_000 } })), "the partial allocation");
  equal([received!.status, paymentUnappliedKobo(received!)], ["partial", 4_000_000], "the payment holds ₦40,000.00 more");
  const report = close(state, "2027-07-05T07:00:00").data.report;
  const [unidentified] = payment(state, "SBX-UNIDENTIFIED-001");
  // The seed is dated from today, so its transfer's age is read, not assumed.
  const aged24 = [received!, unidentified!].filter((item) => Date.parse(wat("2027-07-05T07:00:00")) - paymentObservedAt(item) >= 24 * HOUR).length;
  equal([report.unallocated.count, report.unallocated.kobo, report.unallocated.olderThan24Hours], [2, 4_000_000 + paymentUnappliedKobo(unidentified!), aged24], "the close counts the rest with the unallocated money and its age");
  const [aged] = exceptionsFor(state, received!.id, "unallocated_payment");
  equal([aged?.status, aged?.amountKobo], ["open", 4_000_000], "the rest ages into an exception for Finance");
  check(pageReconciliation(state, "payments", { limit: 25 }, wat("2027-07-05T07:00:00")).items.some((item) => item.id === received!.id), "and is in Finance's payments queue");
  equal(close(state, "2027-07-05T08:00:00").data.report.openingUnallocated.kobo, report.unallocated.kobo, "the next close opens with it");
  // An overpayment's excess is in the queue and the totals, and keeps its own overpayment exception.
  const small = recordsOf(state, "due-items").find((item) => item.customerId === due.customerId && item.id !== due.id) ?? postDue(state, wat("2027-07-05T08:00:00"), due.customerId, String(due.data.mandateId), "DEMO-LOAN-9005", 1_500_000, "2027-08-01");
  addObservation(state, { reference: "TRF-OVER", amountKobo: small.amountKobo + 300_000, source: "transfer", customerId: due.customerId, eventId: "over", occurredAt: wat("2027-07-05T09:00:00") });
  close(state, "2027-07-05T09:05:00");
  const [over] = payment(state, "TRF-OVER");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-05T10:00:00")), { action: "manual_allocate", recordId: over!.id, reason: "Pays this instalment with ₦3,000.00 over.", data: { dueItemId: small.id, amountKobo: small.amountKobo } })), "the overpayment");
  const later = close(state, "2027-07-08T07:00:00").data.report;
  equal([over!.status, later.unallocated.count], ["overpaid", 3], "the excess is counted with the unallocated money");
  equal([exceptionsFor(state, over!.id, "overpayment").length, exceptionsFor(state, over!.id, "unallocated_payment").length], [1, 0], "and has its overpayment exception, not a second one");
  check(pageReconciliation(state, "payments", { limit: 25 }, wat("2027-07-08T07:00:00")).items.some((item) => item.id === over!.id), "Finance can allocate or refund the excess from the queue");
});

// ---------- Item 14: "distinct payments" releases a suspected duplicate ----------
section("a suspected duplicate resolved as a separate payment", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "distinct-payments" });
  const due = recordsOf(state, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(state, { reference: "TRF-D1", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "d1", occurredAt: wat("2027-07-01T10:00:00") });
  addObservation(state, { reference: "TRF-D2", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "d2", occurredAt: wat("2027-07-01T10:01:30") });
  close(state, "2027-07-01T10:05:00");
  const [second] = payment(state, "TRF-D2");
  equal(second!.status, "possible_duplicate", "the second transfer is held");
  const [held] = exceptionsFor(state, second!.id, "suspected_duplicate");
  const resolved = accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Two separate transfers, confirmed with the customer.", data: { resolutionCode: "distinct_payments" } })), "the resolution");
  equal(second!.status, "unallocated", "the hold is released at once");
  check(/released/.test(resolved.message), "and the answer says so");
  const report = close(state, "2027-07-03T07:00:00").data.report;
  check(second!.status !== "possible_duplicate", "the next close does not hold it again");
  equal([report.possibleDuplicates.count, exceptionsFor(state, second!.id, "suspected_duplicate").length], [0, 1], "the close no longer reports it and no new exception is raised");
  equal(second!.data.duplicateReview?.resolutionCode, "distinct_payments", "Finance's decision is on the payment");
  // A confirmed duplicate stays held for its refund.
  const { state: kept } = liveFixture({ withFailure: false, merchantId: "confirmed-duplicate" });
  const keptDue = recordsOf(kept, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(kept, { reference: "TRF-K1", amountKobo: keptDue.amountKobo, source: "transfer", customerId: keptDue.customerId, eventId: "k1", occurredAt: wat("2027-07-01T10:00:00") });
  addObservation(kept, { reference: "TRF-K2", amountKobo: keptDue.amountKobo, source: "transfer", customerId: keptDue.customerId, eventId: "k2", occurredAt: wat("2027-07-01T10:01:00") });
  close(kept, "2027-07-01T10:05:00");
  const [twin] = payment(kept, "TRF-K2");
  accepted(request(kept, () => executeAction(kept, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: exceptionsFor(kept, twin!.id, "suspected_duplicate")[0]!.id, reason: "Charged twice.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "the resolution");
  close(kept, "2027-07-02T07:00:00");
  equal(twin!.status, "possible_duplicate", "a confirmed duplicate keeps its hold until its refund is recorded");
});

// ---------- Review finding 1: a reversal through another connection name is held, never made a payment and reversed ----------
section("reversal evidence through another connection name", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "reversal-other-connection" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-REV-9" });
  addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  const [debit] = payment(state, "PSK-REV-9");
  equal([debit!.status, due.status], ["allocated", "paid"], "the debit pays the instalment");
  // The provider's disputes report spells the connection another way.
  const reversal = addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev1", reversed: true, occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Disputes" } as any);
  close(state, "2027-07-02T07:00:00");
  equal(payment(state, "PSK-REV-9").map((item) => item.id), [debit!.id], "no second payment is made and reversed");
  equal([reversal.status, debit!.data.reversalStatus, debit!.status, due.status], ["unresolved", "none", "allocated", "paid"], "the reversal is held, and the payment is not reversed on a guess");
  const [held] = exceptionsFor(state, reversal.id, "suspected_duplicate");
  check(held && held.status === "open" && held.data.owner === "Finance" && /came through Sandbox Rail Disputes, where no payment has its reference/.test(String(held.data.notes)) && /observed through Sandbox Rail\./.test(String(held.data.notes)), `Finance has an exception that names both connections (${held?.data.notes})`);
  close(state, "2027-07-03T07:00:00");
  equal([reversal.status, exceptionsFor(state, reversal.id).length], ["unresolved", 1], "the next close keeps it held and raises nothing new");
  // Whatever Finance decides, reversal evidence never becomes a payment: once resolved, it is set aside.
  const resolved = accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T09:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "The disputes report reverses a collection on another account.", data: { resolutionCode: "distinct_payments" } })), "Finance's resolution");
  check(/set aside/.test(resolved.message), `the answer says what the next reconciliation does (${resolved.message})`);
  close(state, "2027-07-04T07:00:00");
  equal([reversal.status, reversal.data.resolutionKey, reversal.data.paymentId, reversal.data.resolvedTo, payment(state, "PSK-REV-9").length], ["resolved", "reversal_set_aside_after_review", undefined, `exception:${held!.id}`, 1], "it is set aside, and still no payment is made from it");
  // Reported through the payment's own connection, the reversal reverses it.
  addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev2", reversed: true, occurredAt: wat("2027-07-04T08:00:00") });
  close(state, "2027-07-04T09:00:00");
  equal([payment(state, "PSK-REV-9").length, debit!.data.reversalStatus, due.status, outstandingOf(due)], [1, "reversed", "in_dispute", due.amountKobo], "a reversal through the payment's connection reverses it");
  // A reversal that disagrees with the payment its key names is held the same way and set aside, never made a payment and reversed.
  const { state: other, due: otherDue } = liveFixture({ withFailure: false, merchantId: "reversal-conflict" });
  addAttempt(other, otherDue, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-REV-10" });
  addObservation(other, { reference: "PSK-REV-10", amountKobo: otherDue.amountKobo, source: "webhook", customerId: otherDue.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-01T07:00:00")))), "the second debit");
  const part = addObservation(other, { reference: "PSK-REV-10", amountKobo: 1_000_000, source: "webhook", customerId: otherDue.customerId, eventId: "rev1", reversed: true, occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-02T07:00:00")))), "the reversal of another amount");
  const [partHeld] = exceptionsFor(other, part.id, "suspected_duplicate");
  check(partHeld && partHeld.status === "open" && /reports a reversal/.test(String(partHeld.data.notes)) && /sets it aside/.test(String(partHeld.data.notes)), `its exception says it is set aside once resolved (${partHeld?.data.notes})`);
  accepted(request(other, () => executeAction(other, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: partHeld!.id, reason: "Checked with the provider.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "its resolution");
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-02T10:00:00")))), "the reconciliation after it");
  equal([part.status, part.data.resolutionKey, payment(other, "PSK-REV-10").length, otherDue.status], ["resolved", "reversal_set_aside_after_review", 1, "paid"], "it is set aside and no payment is made from it");
});

section("payments saved before the connection keying", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "legacy-connection-key" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-OLD-1" });
  const first = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  const [legacy] = payment(state, "PSK-OLD-1");
  // As the build before the connection keying left it: its evidence named a connection that build ignored, and the payment took the provider's name.
  first.data.providerConnection = "Sandbox Rail Collections";
  equal([legacy!.data.providerConnection, legacy!.status, due.status], ["Sandbox Rail", "allocated", "paid"], "the payment is keyed on its evidence's provider");
  const named = { provider: "Sandbox Rail", providerConnection: "Sandbox Rail Collections" };
  const line = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo - 12_500, grossAmountKobo: due.amountKobo, feeKobo: 12_500, batchReference: "B-OLD", source: "settlement", customerId: due.customerId, eventId: "old-line", occurredAt: wat("2027-07-02T06:00:00"), ...named } as any);
  const reversal = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-reversal", reversed: true, occurredAt: wat("2027-07-03T06:00:00"), ...named } as any);
  close(state, "2027-07-03T07:00:00");
  equal([payment(state, "PSK-OLD-1").length, line.data.paymentId, reversal.data.paymentId], [1, legacy!.id, legacy!.id], "later evidence through the connection its evidence named still finds it");
  equal([legacy!.data.settlementStatus, legacy!.data.reversalStatus, due.status, exceptionsFor(state, reversal.id).length], ["settled", "reversed", "in_dispute", 0], "its settlement line counts for it and its reversal reverses it");
});

// ---------- Review finding 2: a payer identified through a match later found wrong can be corrected ----------
section("a payer identified through a match later found wrong", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "payer-withdrawn" });
  const dues = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const a = dues[0]!, b = dues.find((item) => item.customerId !== a.customerId)!;
  const customerRef = (id: string) => recordsOf(state, "customers").find((item) => item.id === id)!.reference;
  // A transfer with no payer named, really from customer B.
  addObservation(state, { reference: "TRF-NOPAYER-7", amountKobo: b.amountKobo, source: "transfer", eventId: "np7", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:05:00")))), "the reconciliation");
  const [received] = payment(state, "TRF-NOPAYER-7");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Payer confirmed by phone.", data: { dueItemId: a.id, amountKobo: Math.min(a.amountKobo, received!.amountKobo) } })), "Finance identifying customer A by mistake");
  const wrong = allocationsOf(state, received!.id).find((item) => item.status === "confirmed")!;
  equal([received!.customerId, received!.data.payerIdentification?.allocationId], [a.customerId, wrong.id], "the allocation identified A");
  const reviewed = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "review_allocation", recordId: wrong.id, reason: "Wrong payer: the caller was B.", data: { correct: false } })), "the precision review marking the match wrong");
  equal([received!.customerId, received!.status, received!.data.payerIdentification, outstandingOf(a)], ["", "unallocated", undefined, a.amountKobo], "the identification made through that match is withdrawn with it");
  equal((received!.data.payerIdentificationHistory ?? []).map((item: any) => [item.customerId, item.allocationId, item.reason, item.withdrawnBy, item.withdrawnReason]), [[a.customerId, wrong.id, "Payer confirmed by phone.", "Sandbox Finance", "Wrong payer: the caller was B."]], "its history keeps who identified A, why, and who withdrew it and why");
  check(new RegExp(`Payer identification of customer ${customerRef(a.customerId)} withdrawn for payment TRF-NOPAYER-7`).test(String(reviewed.data.auditNote)) && /withdrawn/.test(reviewed.message), `the answer and the audit entry say so (${reviewed.data.auditNote})`);
  equal([wrong.status, wrong.customerId], ["superseded", a.customerId], "the wrong match keeps the customer it was applied for");
  // Finance now applies the money to its real payer.
  const real = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T11:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Real payer is B.", data: { dueItemId: b.id, amountKobo: Math.min(b.amountKobo, received!.amountKobo) } })), "the allocation to the real payer B");
  equal([received!.customerId, received!.data.payerIdentification?.customerId, b.status], [b.customerId, b.customerId, "paid"], "B is identified and paid");
  check(new RegExp(`Payer identified as customer ${customerRef(b.customerId)}`).test(String(real.data.auditNote)), "and the audit entry names B");
  close(state, "2027-07-03T07:00:00");
  // The wrong match, reviewed as correct again now that B is the payer, is refused with the reason.
  const again = request(state, () => executeAction(state, finance(wat("2027-07-03T08:00:00")), { action: "review_allocation", recordId: wrong.id, reason: "Second look.", data: { correct: true } }));
  check(!again.ok && again.status === 409 && /another customer/.test(again.message), `a match for the withdrawn payer is not applied again (${!again.ok && again.message})`);
  // Reviewed as correct while the payment still has no payer, the match is applied again and identifies its payer again.
  const { state: back } = liveFixture({ withFailure: false, merchantId: "payer-reinstated" });
  const backDue = recordsOf(back, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(back, { reference: "TRF-NOPAYER-8", amountKobo: backDue.amountKobo, source: "transfer", eventId: "np8", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(back, () => reconcile(back, finance(wat("2027-07-01T09:05:00")))), "the second reconciliation");
  const [second] = payment(back, "TRF-NOPAYER-8");
  accepted(request(back, () => executeAction(back, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: second!.id, reason: "Payer confirmed by the narration.", data: { dueItemId: backDue.id, amountKobo: backDue.amountKobo } })), "the identification");
  const match = allocationsOf(back, second!.id)[0]!;
  accepted(request(back, () => executeAction(back, finance(wat("2027-07-02T10:00:00")), { action: "review_allocation", recordId: match.id, reason: "Looks wrong.", data: { correct: false } })), "the review marking it wrong");
  equal(second!.customerId, "", "the payer is withdrawn");
  const restored = accepted(request(back, () => executeAction(back, finance(wat("2027-07-02T11:00:00")), { action: "review_allocation", recordId: match.id, reason: "It was right after all.", data: { correct: true } })), "the review marking it correct again");
  equal([match.status, second!.customerId, second!.data.payerIdentification?.reason, backDue.status], ["confirmed", backDue.customerId, "It was right after all.", "paid"], "the match is applied again and identifies the payer again");
  check(/Payer identified as customer/.test(String(restored.data.auditNote)), "and the audit entry says so");
});

// ---------- Review finding 3: a net-only settlement line applied before the debit's webhook ----------
section("a net-only line applied before the debit's gross", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "net-applied-then-gross" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-NET-1" });
  addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_487_500, batchReference: "B-NET-1", source: "settlement", eventId: "line-1", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T07:00:00")))), "the settlement line");
  const [line] = payment(state, "PSK-NET-1");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "manual_allocate", recordId: line!.id, reason: "Debit reference is this instalment.", data: { dueItemId: due.id, amountKobo: 2_487_500 } })), "Finance applying the net");
  equal([due.status, outstandingOf(due)], ["partially_paid", 12_500], "the instalment owes the fee the net left out");
  const webhook = addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "w-1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-03T07:00:00")))), "the debit's webhook");
  equal([payment(state, "PSK-NET-1").length, webhook.status, webhook.data.paymentId, exceptionsFor(state, webhook.id).length], [1, "resolved", line!.id, 0], "the gross agrees with the payment the net made, whatever is applied, and is not held as a duplicate");
  equal([line!.amountKobo, line!.data.grossUnstated, line!.status, paymentUnappliedKobo(line!)], [2_500_000, undefined, "partial", 12_500], "the gross raises the payment, and the difference is unapplied money for Finance");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T09:00:00")), { action: "manual_allocate", recordId: line!.id, reason: "The rest of the debit.", data: { dueItemId: due.id, amountKobo: 12_500 } })), "Finance applying the rest");
  equal([due.status, line!.status, paymentUnappliedKobo(line!)], ["paid", "allocated", 0], "one collection pays the instalment once");
  // Once the payment's money went back, a larger gross is held as before.
  const { state: refunded, due: refundedDue } = liveFixture({ withFailure: false, merchantId: "net-refunded-then-gross" });
  addObservation(refunded, { reference: "PSK-NET-2", amountKobo: 2_487_500, batchReference: "B-NET-2", source: "settlement", eventId: "line-2", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(refunded, () => reconcile(refunded, finance(wat("2027-07-02T07:00:00")))), "the second line");
  const [returned] = payment(refunded, "PSK-NET-2");
  accepted(request(refunded, () => executeAction(refunded, finance(wat("2027-07-02T08:00:00")), { action: "record_refund", recordId: returned!.id, reason: "Paid back.", data: { reference: "RF-***2" } })), "its refund");
  const late = addObservation(refunded, { reference: "PSK-NET-2", amountKobo: 2_500_000, source: "webhook", customerId: refundedDue.customerId, eventId: "w-2", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(refunded, () => reconcile(refunded, finance(wat("2027-07-03T07:00:00")))), "the webhook after the refund");
  equal([late.status, returned!.amountKobo, exceptionsFor(refunded, late.id, "suspected_duplicate").length], ["unresolved", 2_487_500, 1], "a refunded payment is not raised: the gross is held for Finance");
  // Evidence the earlier rule held joins its payment at the next reconciliation, and its exception closes as its condition cleared.
  const { state: earlier, due: earlierDue } = liveFixture({ withFailure: false, merchantId: "net-held-earlier" });
  addObservation(earlier, { reference: "PSK-NET-3", amountKobo: 2_487_500, batchReference: "B-NET-3", source: "settlement", eventId: "line-3", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(earlier, () => reconcile(earlier, finance(wat("2027-07-02T07:00:00")))), "the third line");
  const [third] = payment(earlier, "PSK-NET-3");
  accepted(request(earlier, () => executeAction(earlier, finance(wat("2027-07-02T08:00:00")), { action: "manual_allocate", recordId: third!.id, reason: "This instalment.", data: { dueItemId: earlierDue.id, amountKobo: 2_487_500 } })), "Finance applying the third net");
  const heldEarlier = addObservation(earlier, { reference: "PSK-NET-3", amountKobo: 2_500_000, source: "webhook", customerId: earlierDue.customerId, eventId: "w-3", occurredAt: wat("2027-07-01T06:00:00") });
  const stale = makeRecord(earlier, "exceptions", { name: "Suspected duplicate", status: "open", customerId: earlierDue.customerId, amountKobo: 2_500_000, createdAt: wat("2027-07-02T09:00:00"), data: { type: "suspected_duplicate", severity: "high", owner: "Finance", notes: "Held by the earlier rule.", linkedRecordId: heldEarlier.id, condition: `suspected_duplicate:${heldEarlier.id}:${third!.id}` } });
  const cleared = accepted(request(earlier, () => executeAction(earlier, finance(wat("2027-07-03T07:00:00")), { action: "daily_close" })), "the close after the rule changed");
  equal([heldEarlier.status, heldEarlier.data.paymentId, third!.amountKobo], ["resolved", third!.id, 2_500_000], "the held gross joins its payment");
  equal([stale.status, stale.data.resolutionCode], ["closed", "condition_cleared"], "its exception closes as its condition cleared");
  check(/suspected duplicate: payment evidence PSK-NET-3 is now resolved/.test(String(cleared.data.auditNote)), `and the close's audit entry names it (${cleared.data.auditNote})`);
});

// ---------- Review finding 4: a gross below the amount received ----------
section("a zero or understated gross", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "zero-gross" });
  const csv = "reference,amount,grossAmountKobo,batchReference,source,eventId,occurredAt\nPSK-ZERO-1,1.00,0.00,B-Z,settlement,z-1,2027-07-01T06:00:00Z";
  const imported = importCsv(state, ctxAt(wat("2027-07-01T08:00:00"), "Finance"), { kind: "observations", csv, syntheticOnly: true, commit: true, amountUnit: "naira" });
  equal([imported.valid, imported.invalid, imported.imported], [0, 1, 0], "a settlement line whose gross is below its amount is refused");
  check(/gross amount cannot be less than the amount received/.test(imported.rows[0]!.message), `with the reason (${imported.rows[0]!.message})`);
  const low = request(state, () => postObservation(state, wat("2027-07-01T08:00:00"), { reference: "PSK-LOW-1", amountKobo: 2_487_500, data: { source: "settlement", grossAmountKobo: 2_487_499, batchReference: "B-Z", eventId: "low-1" } }));
  check(!low.ok && /gross amount cannot be less than the amount received/.test(low.message), "and so is the same evidence posted as a record");
  accepted(request(state, () => postObservation(state, wat("2027-07-01T08:00:00"), { reference: "PSK-EVEN-1", amountKobo: 2_500_000, data: { source: "webhook", grossAmountKobo: 2_500_000, eventId: "even-1" } })), "a gross equal to the amount");
  // A 0-kobo payment an earlier build made from such a line waits for nobody: no exception opens and closes at every close.
  const zero = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "PSK-ZERO-OLD", customerId: due.customerId, amountKobo: 0, createdAt: wat("2027-07-01T06:00:00"), data: { providerReference: "PSK-ZERO-OLD", providerConnection: "Sandbox Rail", currency: "NGN", channel: "direct_debit", observedAt: wat("2027-07-01T06:00:00"), virtualAccountCustomerId: due.customerId, collectionStatus: "succeeded", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, canonical: true } });
  equal(paymentAwaitsAllocation(zero), false, "a payment with nothing unapplied does not wait for Finance");
  for (const day of ["2027-07-02", "2027-07-03", "2027-07-04"]) close(state, `${day}T07:00:00`);
  equal([exceptionsFor(state, zero.id).length, zero.status], [0, "unallocated"], "no close raises an exception for it");
  check(!pageReconciliation(state, "payments", { limit: 100 }, wat("2027-07-04T08:00:00")).items.some((item) => item.id === zero.id), "and it is not in Finance's payments queue");
});

// ---------- Review finding 5: money in another currency stays out of naira totals ----------
section("money in another currency", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "other-currency" });
  const baseline = close(state, "2027-07-01T08:00:00").data.report.unallocated;
  const before = positionFor(state, due.customerId);
  addObservation(state, { reference: "CARD-USD-1", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "usd-1", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  const report = close(state, "2027-07-02T10:00:00").data.report;
  const [usd] = payment(state, "CARD-USD-1");
  equal([usd!.status, usd!.data.currency, exceptionsFor(state, usd!.id, "unallocated_payment").length], ["unallocated", "USD", 1], "the USD payment is held with its exception");
  equal(positionFor(state, due.customerId), before, "the customer's naira position leaves it out");
  equal([report.unallocated.count, report.unallocated.kobo], [baseline.count, baseline.kobo], "the close's naira totals leave it out");
  equal((report.unallocated as any).otherCurrencies, { USD: { count: 1, amount: 100_000 } }, "and list it in its own currency");
  check(!report.customerPositionsChanged.some((item: { customerId: string }) => item.customerId === due.customerId), "no naira position changed");
  const next = close(state, "2027-07-02T11:00:00").data.report;
  equal([next.openingUnallocated.kobo, (next.openingUnallocated as any).otherCurrencies], [baseline.kobo, { USD: { count: 1, amount: 100_000 } }], "the next close opens with it listed the same way");
  equal("otherCurrencies" in baseline, false, "a close with naira alone lists no other currency");
});

// ---------- Review finding 8: a line an earlier build counted in two batches ----------
section("a line an earlier build counted in two batches", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "counted-twice-earlier" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-P3" });
  addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, eventId: "l1", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T07:00:00")))), "the first line");
  const [first] = recordsOf(state, "settlement-batches");
  const [collected] = payment(state, "PSK-P3");
  // What the build before the fix left behind: the same collection also counted in batch B-2, which its statement credit reconciled.
  const line = addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-2", source: "settlement", customerId: due.customerId, eventId: "l2", occurredAt: wat("2027-07-03T06:00:00") });
  const second = makeRecord(state, "settlement-batches", { ...structuredClone(first!), id: undefined, reference: "B-2", name: "Settlement batch B-2", status: "reconciled", data: { ...structuredClone(first!.data), batchReference: "B-2", lineObservationIds: [line.id], linePaymentIds: [collected!.id] } } as any);
  Object.assign(line, { status: "resolved" }); Object.assign(line.data, { paymentId: collected!.id, settlementBatchId: second.id, resolutionKey: "canonical_provider_reference" });
  addObservation(state, { reference: "STMT-B2", amountKobo: 2_487_500, batchReference: "B-2", source: "statement", eventId: "s2", occurredAt: wat("2027-07-03T08:00:00") });
  close(state, "2027-07-04T07:00:00");
  const [raised] = exceptionsFor(state, second.id, "settlement_variance");
  check(raised && raised.status === "open" && /PSK-P3/.test(String(raised.data.notes)) && /B-1/.test(String(raised.data.notes)) && /B-2/.test(String(raised.data.notes)), `the later batch has an exception naming both batches (${raised?.data.notes})`);
  equal([raised?.data.condition, raised?.amountKobo, exceptionsFor(state, first!.id, "settlement_variance").length], [`settlement_variance:${second.id}:counted:${collected!.id}`, 2_500_000, 0], "raised once for the collection counted again, on the later batch only");
  close(state, "2027-07-05T07:00:00");
  equal(exceptionsFor(state, second.id, "settlement_variance").length, 1, "the next close raises nothing new");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "resolve_exception", recordId: raised!.id, reason: "The provider paid it out twice and recovered it.", data: { resolutionCode: "provider_corrected" } })), "Finance's resolution");
  close(state, "2027-07-06T07:00:00");
  equal(exceptionsFor(state, second.id, "settlement_variance").map((item) => item.status), ["resolved"], "the resolution holds while the condition does");
});

// ---------- One inconsistent record never stops the lender's close ----------
section("conflicting evidence beside ordinary evidence", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "contained" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled" && item.id !== due.id);
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-OK" });
  addObservation(state, { reference: "PSK-OK", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "ok", occurredAt: wat("2027-07-01T06:00:00") });
  addObservation(state, { reference: "TRF-CLASH", amountKobo: a!.amountKobo, source: "transfer", customerId: a!.customerId, eventId: "clash-a", occurredAt: wat("2027-07-01T06:00:00") });
  const clash = addObservation(state, { reference: "TRF-CLASH", amountKobo: b!.amountKobo, source: "card", customerId: b!.customerId, dueItemId: b!.id, eventId: "clash-b", occurredAt: wat("2027-07-01T06:00:00") });
  addAttempt(state, b!, { status: "sent", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-NOBODY" });
  addObservation(state, { reference: "PSK-NOBODY", amountKobo: b!.amountKobo, source: "settlement", batchReference: "B-C", eventId: "nobody", occurredAt: wat("2027-07-01T06:30:00") });
  const report = close(state, "2027-07-01T09:00:00").data.report;
  equal([due.status, allocationsOf(state, payment(state, "PSK-OK")[0]!.id)[0]?.data.rule], ["paid", "R1"], "the ordinary evidence is matched");
  equal([clash.status, exceptionsFor(state, clash.id, "suspected_duplicate").length], ["unresolved", 1], "the conflicting evidence is held with an exception");
  equal(payment(state, "PSK-NOBODY")[0]!.status, "proposed", "the evidence with no payer waits for Finance");
  check(report.positionRebuild.alert === false, "and the close's position check holds");
});

// ---------- Money is conserved over random operations, and evidence is never merged into another payer's payment ----------
let propertyRuns = "";
section("random operations", () => {
  const property = propertyRun(Number(process.env.EVIDENCE_SEEDS || 16), Number(process.env.EVIDENCE_STEPS || 45));
  propertyRuns = `${property.applied} operations applied across ${property.seeds} seeds`;
  equal(property.violations, [], "no invariant is broken and no close or reconciliation is refused");
  check(property.applied > property.seeds * 20, `most operations applied (${property.applied})`);
  checks += property.checked;
});

function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Money and evidence invariants after every request. */
function invariants(state: DomainState): string[] {
  const problems: string[] = [];
  const allocations = recordsOf(state, "allocations"), payments = recordsOf(state, "payments"), byId = new Map(state.records.map((item) => [item.id, item]));
  for (const p of payments) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.paymentId === p.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (Number(p.data.allocatedKobo || 0) !== confirmed) problems.push(`payment ${p.reference}: allocatedKobo ${p.data.allocatedKobo} is not its confirmed allocations ${confirmed}`);
    const reversed = p.data.reversalStatus === "reversed";
    if (!reversed && confirmed + paymentRefundedKobo(p) + paymentUnappliedKobo(p) !== p.amountKobo) problems.push(`payment ${p.reference}: ${p.amountKobo} is not allocated + refunded + unapplied`);
    if (reversed && confirmed > 0) problems.push(`payment ${p.reference}: reversed with money applied`);
    if (confirmed > 0 && !p.customerId) problems.push(`payment ${p.reference}: applied with no payer`);
    if (p.status === "unallocated" && confirmed > 0) problems.push(`payment ${p.reference}: unallocated with money applied`);
    for (const a of allocations.filter((item) => item.data.paymentId === p.id && item.status === "confirmed")) if (a.customerId !== p.customerId) problems.push(`allocation on ${p.reference}: payer ${a.customerId} is not the payment's`);
  }
  for (const d of recordsOf(state, "due-items")) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.dueItemId === d.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (d.status !== "cancelled" && outstandingOf(d) !== d.amountKobo - confirmed) problems.push(`due ${d.reference}: outstanding ${outstandingOf(d)} is not ${d.amountKobo} - ${confirmed}`);
  }
  if (positionMismatches(state).length) problems.push("the position rebuild does not match");
  // Resolved evidence agrees with the payment it resolved to: never another payer's, another currency or another gross.
  for (const o of recordsOf(state, "observations").filter((item) => item.status === "resolved" && item.data.paymentId)) {
    const p = byId.get(String(o.data.paymentId)) as ValopayRecord | undefined;
    if (!p) { problems.push(`observation ${o.reference}: resolved to a missing payment`); continue; }
    if (o.customerId && p.customerId && o.customerId !== p.customerId) problems.push(`observation ${o.reference}: merged into another payer's payment`);
    if (String(o.data.currency || "NGN").toUpperCase() !== String(p.data.currency || "NGN").toUpperCase()) problems.push(`observation ${o.reference}: merged across currencies`);
    const gross = Number(o.data.grossAmountKobo ?? o.amountKobo);
    if (o.data.source === "settlement" && o.data.grossAmountKobo === undefined ? gross > p.amountKobo : gross !== p.amountKobo) problems.push(`observation ${o.reference}: ${gross} merged into a payment of ${p.amountKobo}`);
  }
  // A collection's settlement line is counted in one batch; a batch's statement total is its distinct credits.
  const counted = new Map<string, string>();
  for (const batch of recordsOf(state, "settlement-batches")) for (const id of (batch.data.linePaymentIds ?? []) as string[]) {
    if (counted.has(id)) problems.push(`payment ${id}: counted in two settlement batches`);
    counted.set(id, batch.id);
  }
  for (const batch of recordsOf(state, "settlement-batches").filter((item) => item.data.statementObservationId)) {
    const credits = recordsOf(state, "observations").filter((item) => item.data.resolvedTo === `batch:${batch.id}` && !item.data.duplicateStatementCredit);
    const sum = credits.reduce((total, item) => total + item.amountKobo, 0);
    if (sum !== batch.data.statementNetKobo) problems.push(`batch ${batch.reference}: statement total ${batch.data.statementNetKobo} is not its credits ${sum}`);
  }
  return problems;
}

/** The audit's property run, extended with shared references, other connections and currencies, several credits and lines in two batches. */
function propertyRun(seeds: number, steps: number) {
  const violations: string[] = [];
  let applied = 0, checked = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed);
    const pick = <T,>(items: T[]): T | undefined => (items.length ? items[Math.floor(rand() * items.length)] : undefined);
    let state = liveFixture({ withFailure: false, merchantId: `evidence-${seed}` }).state;
    let clock = Date.parse(wat("2027-06-30T08:00:00")), counter = 0;
    const at = () => new Date(clock).toISOString();
    const dues = () => recordsOf(state, "due-items"), payments = () => recordsOf(state, "payments");
    const ops: Record<string, () => void> = {
      webhook: () => { const due = pick(dues())!; counter++; const ref = rand() < 0.3 && payments().length ? pick(payments())!.reference : `W-${seed}-${counter}`; if (rand() < 0.4) addAttempt(state, due, { status: "succeeded", occurredAt: at(), providerReference: ref }); addObservation(state, { reference: ref, amountKobo: rand() < 0.6 ? due.amountKobo : Math.max(1, Math.floor(due.amountKobo * (0.3 + rand()))), source: "webhook", customerId: due.customerId, dueItemId: rand() < 0.5 ? due.id : undefined, eventId: `e-${counter}`, occurredAt: at() }); },
      transfer: () => { const due = pick(dues())!; counter++; addObservation(state, { reference: rand() < 0.2 && payments().length ? pick(payments())!.reference : `T-${seed}-${counter}`, amountKobo: rand() < 0.5 ? due.amountKobo : Math.max(1, Math.floor(due.amountKobo * (0.3 + rand()))), source: rand() < 0.7 ? "transfer" : "card", customerId: rand() < 0.85 ? due.customerId : "", eventId: `e-${counter}`, occurredAt: at(), narration: rand() < 0.5 ? `pay ${due.reference}` : undefined }); },
      foreign: () => { const due = pick(dues())!; counter++; addObservation(state, { reference: rand() < 0.5 && payments().length ? pick(payments())!.reference : `F-${seed}-${counter}`, amountKobo: due.amountKobo, source: "card", customerId: due.customerId, eventId: `e-${counter}`, occurredAt: at(), ...(rand() < 0.5 ? { provider: "Other Rail" } : { currency: "USD" }) } as any); },
      settlement: () => { const target = pick(payments().filter((item) => item.data.channel === "direct_debit")); counter++; const due = pick(dues())!; const gross = target && rand() < 0.7 ? target.amountKobo : due.amountKobo; const fee = Math.min(100_000, Math.floor(gross * 50 / 10_000)); addObservation(state, { reference: target && gross === target.amountKobo ? target.reference : `S-${seed}-${counter}`, amountKobo: gross - fee, grossAmountKobo: gross, feeKobo: fee, batchReference: `B-${seed}-${Math.floor(counter / 4) - (rand() < 0.2 ? 1 : 0)}`, source: "settlement", customerId: rand() < 0.7 ? target?.customerId ?? due.customerId : "", eventId: `e-${counter}`, occurredAt: at() }); },
      noPayerLine: () => { const attempt = pick(recordsOf(state, "attempts").filter((item) => item.data.providerReference)); if (!attempt) return; counter++; const gross = attempt.amountKobo, fee = Math.min(100_000, Math.floor(gross * 50 / 10_000)); addObservation(state, { reference: String(attempt.data.providerReference), amountKobo: gross - fee, grossAmountKobo: gross, feeKobo: fee, batchReference: `BN-${seed}-${Math.floor(counter / 3)}`, source: "settlement", customerId: "", eventId: `e-${counter}`, occurredAt: at() }); },
      statement: () => { const batch = pick(recordsOf(state, "settlement-batches")); if (!batch) return; counter++; addObservation(state, { reference: rand() < 0.3 ? `ST-${batch.reference}` : `ST-${seed}-${counter}`, amountKobo: Math.max(1, rand() < 0.6 ? Number(batch.data.netKobo || 1) : Math.floor(Number(batch.data.netKobo || 2) / 2)), batchReference: batch.reference, source: "statement", eventId: `e-${counter}`, occurredAt: at() }); },
      reversal: () => { const target = pick(payments().filter((item) => item.data.canonical)); if (!target) return; counter++; addObservation(state, { reference: target.reference, amountKobo: target.amountKobo, source: "webhook", customerId: target.customerId, eventId: `rev-${counter}`, reversed: true, occurredAt: at(), provider: String(target.data.providerConnection || "Sandbox Rail"), currency: String(target.data.currency || "NGN") } as any); },
      reconcile: () => { reconcile(state, finance(at())); },
      close: () => { executeAction(state, finance(at()), { action: "daily_close" }); },
      confirm: () => { const p = pick(payments().filter((item) => item.status === "proposed")); if (p) executeAction(state, finance(at()), { action: "confirm_allocation", recordId: p.id, reason: "Checked the evidence." }); },
      reject: () => { const p = pick(payments().filter((item) => item.status === "proposed")); if (p) executeAction(state, finance(at()), { action: "reject_allocation", recordId: p.id, reason: "Not this instalment." }); },
      manual: () => { const p = pick(payments()); if (!p) return; const due = pick(dues().filter((item) => !p.customerId || rand() < 0.1 || item.customerId === p.customerId)); if (!due) return; const left = paymentUnappliedKobo(p), owed = outstandingOf(due); executeAction(state, finance(at()), { action: "manual_allocate", recordId: p.id, reason: "Finance identified it.", data: { dueItemId: due.id, amountKobo: rand() < 0.8 ? Math.max(1, Math.floor(Math.min(left, owed) * (rand() < 0.5 ? 1 : rand()))) : left + 1 } }); },
      refund: () => { const p = pick(payments()); if (p) executeAction(state, finance(at()), { action: "record_refund", recordId: p.id, reason: "Refunded outside Valo Pay.", data: { reference: "RF-***1" } }); },
      review: () => { const a = pick(recordsOf(state, "allocations").filter((item) => item.status !== "proposed")); if (a) executeAction(state, finance(at()), { action: "review_allocation", recordId: a.id, reason: "Precision review.", data: { correct: rand() < 0.5 } }); },
      amend: () => { const due = pick(dues())!; const input = structuredClone(due); input.amountKobo = Math.max(1_000_000, Math.floor(due.amountKobo * (0.5 + rand()))); input.data.overrideReason ||= "Amended by the lender."; amendDueItem(state, ctxAt(at(), "Admin"), due, input); },
      resolve: () => { const e = pick(recordsOf(state, "exceptions").filter((item) => ["open", "assigned", "in_progress"].includes(item.status))); if (!e) return; const codes = ({ suspected_duplicate: ["distinct_payments", "confirmed_duplicate_refund", "applied_to_next"], unallocated_payment: ["held_credit", "allocated_manual"], overpayment: ["held_credit"], settlement_variance: ["accepted_variance"], unknown_outcome: ["resolved_failed"] } as Record<string, string[]>)[String(e.data.type)] ?? ["no_action_required"]; executeAction(state, ctxAt(at(), "Admin"), { action: "resolve_exception", recordId: e.id, reason: "Reviewed.", data: { resolutionCode: pick(codes) } }); },
      a2a: () => { const due = pick(dues())!; const owed = outstandingOf(due); if (owed <= 0) return; const ops = ctxAt(at(), "Operations"); const intent = runConnectedAction(state, ops, { action: "payment.create", reason: "Pay by bank.", expectedRevision: connectedRevision(state), data: { dueItemId: due.id, amountKobo: Math.max(1, Math.floor(owed * (rand() < 0.6 ? 1 : rand()))) } } as any) as ValopayRecord; runConnectedAction(state, ops, { action: "payment.authorise", recordId: intent.id, reason: "Authorised.", expectedRevision: connectedRevision(state), data: {} } as any); runConnectedAction(state, ops, { action: "payment.outcome", recordId: intent.id, reason: "Confirmed.", expectedRevision: connectedRevision(state), data: { outcome: "confirmed" } } as any); },
      attempt: () => { const due = pick(dues().filter((d) => !recordsOf(state, "attempts").some((a) => a.data.dueItemId === d.id && ["scheduled", "sent", "unknown"].includes(a.status)))); if (!due) return; counter++; addAttempt(state, due, { status: rand() < 0.5 ? "unknown" : "sent", occurredAt: at(), providerReference: `PR-${seed}-${counter}` }); },
    };
    const weights: [string, number][] = [["webhook", 5], ["transfer", 5], ["foreign", 2], ["settlement", 3], ["noPayerLine", 2], ["statement", 2], ["reversal", 1], ["reconcile", 6], ["close", 2], ["confirm", 3], ["reject", 1], ["manual", 4], ["refund", 2], ["review", 2], ["amend", 1], ["resolve", 3], ["a2a", 1], ["attempt", 2]];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (let step = 0; step < steps; step++) {
      clock += Math.floor(rand() * 6 * HOUR) + 60_000;
      let roll = rand() * total, name = weights[0]![0];
      for (const [candidate, weight] of weights) if ((roll -= weight) < 0) { name = candidate; break; }
      const before = structuredClone(state);
      try {
        ops[name]!();
        assertFinalState(structuredClone(before), state, state.merchant.id, at());
        applied += 1;
      } catch (error) {
        state = before;
        if (name === "reconcile" || name === "close") violations.push(`seed ${seed} step ${step}: ${name} refused: ${(error as Error).message}`);
      }
      const problems = invariants(state);
      checked += 1;
      for (const problem of problems) violations.push(`seed ${seed} step ${step} after ${name}: ${problem}`);
      if (problems.length) break;
    }
  }
  return { violations: [...new Set(violations)].slice(0, 20), applied, seeds, checked };
}

if (failures.length) {
  console.error(failures.join("\n"));
  assert.fail(`${failures.length} payment evidence section(s) failed`);
}
console.log(`Payment evidence golden tests passed (${checks} checks): evidence with no payer and Finance's payer identification, evidence that shares a reference, R1's currency and connection, R4's narration references, statement credits and lines across settlement batches, the rest of a partly allocated payment, distinct payments, a close that contains a conflict and the conservation property run (${propertyRuns}).`);
