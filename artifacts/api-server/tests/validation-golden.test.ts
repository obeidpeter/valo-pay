// Golden tests for the shared per-kind schema as enforced by the validator and actions.
import assert from "node:assert/strict";
import { completeCutover, ctxAt, liveFixture, wat } from "./helpers.js";
import { validateRecord } from "../src/domain/validation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { exceptionCatalogue, recordStatuses } from "@workspace/valopay-schema";

let checks = 0;
const admin = ctxAt(wat("2027-07-01T09:00:00"), "Admin");
const ops = ctxAt(wat("2027-07-01T09:00:00"), "Operations");
const patch = (record: any, changes: any) => ({ ...record, ...changes, data: { ...record.data, ...(changes.data || {}) } });

// ---------- Mandate state machine (4.2): terminal states stay terminal; reasons come through actions ----------
{
  const state = seedMerchant("machine");
  const mandate = recordsOf(state, "mandates").find((item) => item.status === "suspended")!;
  mandate.status = "cancelled";
  assert.throws(() => validateRecord(state, ops, "mandates", patch(mandate, { status: "active" }), true), /cancelled mandate cannot move to active/);
  const pending = recordsOf(state, "mandates").find((item) => item.status === "pending_activation")!;
  assert.doesNotThrow(() => validateRecord(state, ops, "mandates", patch(pending, { status: "active" }), true), "activation confirmed by the provider");
  assert.doesNotThrow(() => validateRecord(state, ops, "mandates", patch(pending, { status: "expired" }), true));
  const active = recordsOf(state, "mandates").find((item) => item.status === "active")!;
  assert.throws(() => validateRecord(state, ops, "mandates", patch(active, { status: "cancelled" }), true), /through its action/);
  assert.throws(() => validateRecord(state, ops, "mandates", patch(active, { status: "pending_activation" }), true), /cannot move/);
  checks += 5;
}

// ---------- Exception machine (EXC-03): resolution needs a controlled code for the type ----------
{
  const state = seedMerchant("exceptions");
  const exception = recordsOf(state, "exceptions").find((item) => item.data.type === "activation_expired")!;
  assert.throws(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "closed" }), true), /cannot move to closed/);
  assert.throws(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "resolved" }), true), /Use Resolve exception and choose a resolution/);
  assert.doesNotThrow(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "assigned", data: { owner: "Ada" } }), true));
  assert.throws(() => executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "done", data: { resolutionCode: "allocated" } }), /must be one of: reissued, customer_declined, wrong_number, abandoned/);
  executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "done", data: { resolutionCode: "reissued" } });
  assert.equal(exception.status, "resolved");
  assert.doesNotThrow(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "closed" }), true), "closing follows resolution");
  assert.throws(() => executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "again", data: { resolutionCode: "reissued" } }), /already resolved/);
  // A legacy type alias resolves to the catalogue and creation fills owner, severity and SLA from Appendix A.
  const created: any = { name: "dup", status: "open", customerId: "", amountKobo: 0, data: { type: "possible_duplicate", linkedRecordId: recordsOf(state, "payments")[0]!.id } };
  validateRecord(state, ops, "exceptions", created);
  assert.equal(created.data.type, "suspected_duplicate");
  assert.equal(created.data.owner, exceptionCatalogue.suspected_duplicate.owner);
  assert.equal(created.data.severity, "high");
  assert.ok(created.data.dueBy > admin.now);
  assert.throws(() => validateRecord(state, ops, "exceptions", { name: "x", status: "open", data: { type: "something_else" } }), /Unknown exception type/);
  assert.throws(() => validateRecord(state, ops, "exceptions", { name: "x", status: "open", data: {} }), /type/);
  checks += 13;
}

// ---------- Cutover contract (DEB-11, 10.4): no owner valo until step 5 is complete; the ready flag needs the steps ----------
{
  const state = seedMerchant("cutover");
  const customer = recordsOf(state, "customers")[0]!;
  const cutover = recordsOf(state, "cutovers")[0]!;
  const input = () => ({ name: "d", status: "scheduled", customerId: customer.id, amountKobo: 2_500_000, data: { dueDate: "2027-08-01", owner: "valopay" } });
  assert.throws(() => validateRecord(state, admin, "due-items", input()), /handover agreement and parallel-run day are complete/);
  assert.throws(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "ready", data: { accountableUser: "Ops", confirmation: "signed" } }), true), /previous collection system is disabled in writing/);
  assert.doesNotThrow(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "ready", data: { accountableUser: "Ops", confirmation: "signed", incumbentDisabled: true, externalAttemptsImported: true, dualRunComplete: true } }), true));
  completeCutover(state);
  assert.doesNotThrow(() => validateRecord(state, admin, "due-items", input()));
  const aliased: any = { ...input(), data: { dueDate: "2027-08-01", owner: "valo" } };
  validateRecord(state, admin, "due-items", aliased);
  assert.equal(aliased.data.owner, "valopay", "the TRD's owner spelling is accepted and normalised");
  assert.throws(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "handed_back" }), true), /Use Return collection ownership/);
  checks += 6;
}

// ---------- Attempts: failure codes are normalised to the 4.4 catalogue, raw codes kept for mapping ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "codes" });
  const attempt = (failureCode: string): any => ({ name: "a", status: "failed", customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, source: "external", simulated: true, failureCode, occurredAt: wat("2027-06-28T06:16:00") } });
  const aliased = attempt("ACCOUNT_CLOSED"); validateRecord(state, ops, "attempts", aliased);
  assert.equal(aliased.data.failureCode, "INVALID_ACCOUNT"); assert.equal(aliased.data.rawFailureCode, undefined);
  const unmapped = attempt("R99 weird provider text"); validateRecord(state, ops, "attempts", unmapped);
  assert.equal(unmapped.data.failureCode, "UNKNOWN"); assert.equal(unmapped.data.rawFailureCode, "R99 weird provider text");
  assert.equal(unmapped.data.number, 1, "DEB-05: numbered across sources");
  assert.throws(() => executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "NOT_A_CODE" } }), /Unknown failure code/);
  const unknown = executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "TIMEOUT_UNKNOWN" } }).record!;
  assert.equal(unknown.status, "unknown", "an unknown outcome is not a failure");
  assert.throws(() => executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "INSUFFICIENT_FUNDS" } }), /still pending or has an unknown outcome/);
  checks += 7;
}

// ---------- Settlement batches and statuses from the shared vocabulary ----------
{
  const state = seedMerchant("batches");
  const finance = ctxAt(wat("2027-07-01T09:00:00"), "Finance");
  const batch: any = { name: "b", status: "pending", reference: "B-1", data: { provider: "Sandbox Rail", grossKobo: 100, feeKobo: 10, netKobo: 90 } };
  validateRecord(state, finance, "settlement-batches", batch);
  assert.equal(batch.data.batchReference, "B-1", "the top-level reference is the batch reference");
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, status: "settled" }), /Allowed: pending, reconciled, variance/);
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, status: "reconciled" }), /set by a domain action|Batches start pending/);
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, data: { ...batch.data, netKobo: 80 } }), /gross amount minus fees/);
  const customer: any = { name: "c", status: "inactive", data: { consentProvenance: "Imported" } };
  assert.doesNotThrow(() => validateRecord(state, ops, "customers", customer));
  assert.throws(() => validateRecord(state, ops, "customers", { ...customer, status: "archived" }), new RegExp(`Allowed: ${recordStatuses.customers.join(", ")}`));
  assert.throws(() => validateRecord(state, ops, "customers", { name: "c", status: "active", data: {} }), /consentProvenance/);
  const policy: any = { name: "p", status: "draft", data: { version: "2", maxAttempts: 3, spacingHours: 48, firstNoticeHours: 48, retryNoticeHours: 24, author: admin.actor } };
  validateRecord(state, admin, "policies", policy);
  assert.equal(policy.data.version, 2, "coerced numbers are written back");
  assert.throws(() => validateRecord(state, admin, "policies", { ...policy, data: { ...policy.data, maxAttempts: 5 } }), /no more than 4 attempts/);
  assert.throws(() => validateRecord(state, admin, "policies", { ...policy, data: { ...policy.data, spacingHours: 12 } }), /at least 24 hours between attempts/);
  const calendar: any = { name: "h", status: "active", data: { date: "not-a-date" } };
  assert.throws(() => validateRecord(state, admin, "calendar", calendar), /YYYY-MM-DD/);
  checks += 11;
}

console.log(`Validation golden tests passed (${checks} checks): state machines, exception codes, cutover contract, failure-code normalisation, batch and status vocabularies.`);
