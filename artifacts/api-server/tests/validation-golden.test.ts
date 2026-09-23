// Golden tests for the shared per-kind schema as enforced by the validator and actions.
import assert from "node:assert/strict";
import { addObservation, completeCutover, ctxAt, liveFixture, wat } from "./helpers.js";
import { validateRecord } from "../src/domain/validation.js";
import { executeAction } from "../src/domain/actions.js";
import { assertNoRealBankDetails, makeRecord, recordsOf } from "../src/domain/records.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { exceptionCatalogue, recordStatuses } from "@workspace/valopay-schema";
import { importCsv } from "../src/lib/valopay-import.js";

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

// Template review is a complete lifecycle; malformed placeholders never reach approval.
{
  const state = seedMerchant('template-review');
  const template = recordsOf(state, 'templates')[0]!;
  const reviewer = ctxAt(admin.now, 'Compliance reviewer');
  const act = (action: string, ctx = admin, recordId = template.id, reason = 'Synthetic review evidence') => executeAction(state, ctx, { action, recordId, reason });
  const originalText = template.data.text;
  for (const suffix of [' {{unknown}}', ' {{amount}', ' {amount}', ' {{}}', ' {{{amount}}}']) {
    assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + suffix } }), true), /placeholder|braces/);
    checks++;
  }
  assert.doesNotThrow(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: '{{ merchant }} {{ amount }} {{ date }} {{ contact }}' } }), true));
  act('submit_template');
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + ' Changed.' } }), true), /submitted template cannot be edited/);
  assert.throws(() => act('reject_template', { ...reviewer, actor: admin.actor }), /other than its author/);
  assert.throws(() => act('reject_template', reviewer, template.id, '  '), /Enter a reason/);
  act('reject_template', reviewer, template.id, 'Explain the date more clearly.');
  assert.equal(template.status, 'rejected');
  assert.equal(template.data.rejectionReason, 'Explain the date more clearly.');
  assert.equal((template.data.reviewHistory as unknown[]).length, 1);
  assert.doesNotThrow(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + ' Thank you.' } }), true));
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { rejectionReason: 'No changes requested' } }), true), /cannot be changed here/);
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { version: 99 } }), true), /assigned/);
  act('submit_template'); act('approve_template', reviewer);
  assert.equal(template.status, 'approved');
  assert.equal((template.data.reviewHistory as unknown[]).length, 2);
  const approved = structuredClone(template);
  const second = act('new_template_version').record!;
  const third = act('new_template_version').record!;
  assert.equal(second.data.version, 2); assert.equal(third.data.version, 3);
  assert.equal(second.data.previousVersionId, template.id);
  assert.equal(second.data.reviewer, undefined); assert.equal(second.data.rejectionReason, undefined);
  assert.deepEqual(template, approved);
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { name: 'Overwrite approved' }), true), /Approved versions cannot be edited/);
  assert.throws(() => act('new_template_version', reviewer), /not permitted/);
  assert.throws(() => act('new_template_version', admin, second.id), /approved template/);
  second.status = 'submitted'; second.data.text = originalText + ' {{injected}}';
  assert.throws(() => act('approve_template', reviewer, second.id), /Unknown placeholder \{\{injected\}\}\. Use only \{\{amount\}\}/);
  second.data.text = originalText; delete second.data.author;
  assert.throws(() => act('approve_template', reviewer, second.id), /other than its author/);
  checks += 23;
}

// CSV mapping, quoted previews and all-or-nothing commits share the production parser.
{
  const state = seedMerchant('guided-import');
  const before = structuredClone(state);
  const input = { kind: 'customers', syntheticOnly: true, commit: false, csv: 'Full name,External ref,Consent,Unused\n"Sample, Person",SAMPLE-CSV-1,"Synthetic\nconsent",ignore', mapping: { 'Full name': 'name', 'External ref': 'reference', Consent: 'consentProvenance', Unused: '' } };
  const preview = importCsv(state, admin, input);
  assert.equal(preview.valid, 1); assert.equal(preview.imported, 0); assert.equal(preview.skipped, 0);
  assert.deepEqual(preview.columns, ['Full name', 'External ref', 'Consent', 'Unused']);
  assert.equal(preview.preview[0]?.values['Full name'], 'Sample, Person');
  assert.equal(preview.preview[0]?.values.Consent, 'Synthetic\nconsent');
  assert.deepEqual(state, before);
  const committed = importCsv(state, admin, { ...input, commit: true });
  assert.equal(committed.imported, 1);
  const again = importCsv(state, admin, { ...input, commit: true });
  assert.equal(again.imported, 0); assert.equal(again.skipped, 1);
  assert.equal(state.records.find(record => record.reference === 'SAMPLE-CSV-1')?.data.Unused, undefined);
  const stableCount = state.records.length;
  const invalid = importCsv(state, admin, { ...input, csv: 'name,reference,consentProvenance\nValid,SAMPLE-CSV-2,Synthetic\nInvalid,SAMPLE-CSV-3,', mapping: undefined, commit: true });
  assert.equal(invalid.valid, 1); assert.equal(invalid.invalid, 1); assert.equal(invalid.imported, 0); assert.equal(state.records.length, stableCount);
  assert.match(invalid.rows[0]!.message, /Not imported/);
  assert.throws(() => importCsv(state, admin, { ...input, syntheticOnly: false }), /Only synthetic/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { 'Full name': 'name', 'External ref': 'name' } }), /only once/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { Consent: '__proto__' } }), /valid destination/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { Unknown: 'name' } }), /valid destination/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name,name\nOne,Two' }), /different, non-empty header/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: '__proto__,name\nobject,Name' }), /Reserved object names/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n' + 'é'.repeat(750001) }), /1.5 MB/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n' + Array.from({ length: 501 }, () => 'Sample').join('\n') }), /between 1 and 500/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n"Unclosed' }), /CSV could not be parsed/);
  checks += 25;
}

// CSV numbers: a blank optional number is absent, while a blank amount and a receipt of ₦0 are row errors.
{
  const state = seedMerchant("blank-numbers");
  const rows = (kind: string, csv: string, extra: Partial<Parameters<typeof importCsv>[2]> = {}) => importCsv(state, admin, { kind, csv, syntheticOnly: true, commit: true, amountUnit: "kobo", ...extra });
  const saved = (reference: string) => state.records.find((record) => record.reference === reference)!;
  // Each row was refused before: a blank count read as 0 failed its minimum, and a blank fee failed the amount parser.
  for (const [kind, csv] of [
    ["customers", "name,reference,consentProvenance,payDay\nBlank pay day,IMP-C-BLANK,Synthetic consent,"],
    ["due-items", "name,reference,customerId,amountKobo,dueDate,owner,outstandingKobo\nBlank outstanding,IMP-D-BLANK,DEMO-C1001,1000000,2028-12-01,lms,"],
    ["attempts", "name,reference,customerId,amountKobo,dueItemId,number,failureCode,occurredAt\nBlank number,IMP-A-BLANK,DEMO-C1001,2500000,DEMO-LOAN-1001,,INSUFFICIENT_FUNDS,2028-12-02"],
    ["observations", "name,reference,customerId,amountKobo,source,feeKobo,grossAmountKobo\nBlank fees,IMP-O-BLANK,DEMO-C1001,2500000,webhook,,"],
  ] as const) { const result = rows(kind, csv); assert.equal(result.imported, 1, `${kind}: ${JSON.stringify(result.rows)}`); }
  assert.equal(saved("IMP-C-BLANK").data.payDay, undefined, "a blank pay day is absent, not 0");
  assert.equal(saved("IMP-D-BLANK").data.outstandingKobo, 1000000, "the whole instalment is outstanding");
  assert.equal(saved("IMP-A-BLANK").data.number, 2, "a blank attempt number is worked out after the instalment's earlier attempt");
  assert.deepEqual([saved("IMP-O-BLANK").data.feeKobo, saved("IMP-O-BLANK").data.grossAmountKobo], [undefined, undefined], "blank fees are absent, not ₦0");
  // A blank count was read as 0, so such a row could be valid: its fingerprint is still the one the previous build stored.
  const identities = { source: "blank-lms", batchId: "blank-batch", ids: ["row-1"] };
  const mandate = "name,reference,customerId,amountKobo,workflow,consentEvidence,reminderCount\nBlank reminders,IMP-M-BLANK,DEMO-C1001,5000000,hosted_consent,SYNTHETIC-CONSENT-BLANK,";
  assert.equal(rows("mandates", mandate, { identities }).imported, 1);
  assert.equal(saved("IMP-M-BLANK").data.reminderCount, undefined);
  assert.equal(saved("IMP-M-BLANK").data.importIdentity.fingerprint, "463d15b91cfdf3bc9a19ed3f974bcfb3deb73f0b46319e3989c9cd166372f3f0");
  assert.equal(rows("mandates", mandate, { identities }).rows[0]!.status, "duplicate", "importing the same row again is recognised");
  // The amount is still required wherever a kind has one, with the same row error.
  const noAmount = "name,reference,customerId,amountKobo,dueDate,owner\nBlank amount,IMP-D-NOAMOUNT,DEMO-C1001,,2028-12-01,lms";
  assert.match(rows("due-items", noAmount).rows[0]!.message, /Enter kobo as a whole number/);
  assert.match(rows("due-items", noAmount, { amountUnit: "naira" }).rows[0]!.message, /Enter an amount in naira/);
  // Payment evidence records money received: ₦0, or no amount at all, is refused by the import and the record API alike.
  for (const csv of ["name,reference,customerId,amountKobo,source\nZero receipt,IMP-O-ZERO,DEMO-C1001,0,webhook", "name,reference,customerId,source\nNo amount,IMP-O-NONE,DEMO-C1001,webhook"]) {
    const refused = rows("observations", csv);
    assert.deepEqual([refused.invalid, refused.imported, refused.rows[0]!.message], [1, 0, "Enter the amount received. Payment evidence must be for more than ₦0."]);
  }
  assert.equal(state.records.some((record) => ["IMP-O-ZERO", "IMP-O-NONE", "IMP-D-NOAMOUNT"].includes(record.reference)), false);
  const customerId = saved("IMP-C-BLANK").id;
  assert.throws(() => validateRecord(state, ops, "observations", { name: "Zero", reference: "API-O-ZERO", customerId, amountKobo: 0, data: { source: "webhook" } }), /more than ₦0/);
  assert.doesNotThrow(() => validateRecord(state, ops, "observations", { name: "One kobo", reference: "API-O-ONE", customerId, amountKobo: 1, data: { source: "webhook" } }));
  checks += 19;
}

// ---------- The bank-detail screen refuses account and card numbers, not record IDs ----------
{
  for (const value of [{ accountId: "1234567890" }, { "Account number": "0123456789" }, { bank: "1234-5678-9012" }, { cardNumber: "4111111111111111" }, { virtualAccountCustomerId: "0123456789" }, { accounts: "0123456789" }, { payerCards: "4111 1111 1111 1111" }]) {
    assert.throws(() => assertNoRealBankDetails(value), /Raw (financial identifiers|bank account details)/, `refused: ${JSON.stringify(value)}`);
  }
  // A UUID's digit groups are not an account number, and "company" or "accountable" are not financial words.
  const digitHeavy = "12345678-1234-4123-8123-123456789012";
  for (const value of [{ virtualAccountCustomerId: digitHeavy }, { companyId: "12345678901" }, { accountableUser: "12345678" }, { accountMasked: "•••• 1234" }, { accountRef: `batch ${digitHeavy} line` }]) {
    assert.doesNotThrow(() => assertNoRealBankDetails(value), `accepted: ${JSON.stringify(value)}`);
  }
  // End to end: a customer whose ID has long digit groups carries a virtual-account link and R2 matches it.
  const state = seedMerchant("virtual-account");
  makeRecord(state, "customers", { id: digitHeavy, name: "Synthetic virtual-account customer", status: "active", data: { consentProvenance: "Synthetic imported consent" } });
  const due = makeRecord(state, "due-items", { name: "Virtual account instalment", status: "scheduled", customerId: digitHeavy, amountKobo: 1_000_000, reference: "VA-LOAN-1", data: { dueDate: "2027-07-01", owner: "lms", outstandingKobo: 1_000_000 } });
  addObservation(state, { reference: "VA-1", amountKobo: 1_000_000, source: "transfer", customerId: digitHeavy, virtualAccountCustomerId: digitHeavy, eventId: "va-1", occurredAt: wat("2027-07-01T09:00:00") });
  reconcile(state, ctxAt(wat("2027-07-01T09:05:00"), "Finance"));
  const payment = recordsOf(state, "payments").find((item) => item.reference === "VA-1")!;
  assert.equal(payment.data.virtualAccountCustomerId, digitHeavy);
  assert.equal(payment.status, "allocated");
  assert.equal(recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id)!.data.rule, "R2");
  assert.equal(due.status, "paid");
  checks += 16;
}

console.log(`Validation golden tests passed (${checks} checks): state machines, exception codes, cutover contract, failure-code normalisation, batch/status vocabularies, template lifecycle, guided CSV imports, blank CSV numbers and ₦0 receipts, and the bank-detail screen.`);
