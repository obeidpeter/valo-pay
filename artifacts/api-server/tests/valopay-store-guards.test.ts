import assert from "node:assert/strict";

// The pure guard does not connect, but the repository module verifies that a
// database URL exists while it is loaded.
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState, canonical, appendAudit, expiredWorkspaceCleanupEnabled, verifyAudit, journalReceipt } = await import("../src/lib/valopay-store.js");
const { seedMerchant } = await import("../src/lib/valopay-seed.js");

const seed = () => seedMerchant("merchant-a");
const expectConflict = (run: () => void) => assert.throws(run, (error: any) => error?.status === 409);

assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}', "Historical canonical bytes must not change.");
assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }), "JSONB key reordering must not affect digests.");
assert.equal(expiredWorkspaceCleanupEnabled(undefined), false, "Automatic workspace cleanup must default off.");
assert.equal(expiredWorkspaceCleanupEnabled("off"), false, "Only the explicit opt-in may enable cleanup.");
assert.equal(expiredWorkspaceCleanupEnabled("on"), true, "The documented opt-in must enable cleanup.");
// The journal keeps a reference to what a completed request saved; the whole answer is kept once, as the replay copy.
assert.deepEqual(journalReceipt({ id: "record-1", kind: "customers", name: "Synthetic", data: { note: "x".repeat(1000) } }), { id: "record-1", kind: "customers" }, "A saved record is kept as its reference.");
assert.deepEqual(journalReceipt({ message: "Daily close complete.", record: { id: "close-1", kind: "closes", data: { report: { rows: Array.from({ length: 500 }, () => "x") } } }, data: { closeId: "close-1" } }), { record: { id: "close-1", kind: "closes" } }, "An action keeps a reference to the record it saved, not the record.");
assert.deepEqual(journalReceipt({ id: "run-1", status: "approved", candidates: [] }), { id: "run-1" }, "A result without a record kind keeps its ID.");
for (const answer of [{ message: "Audit log check complete.", data: { valid: true } }, null, undefined, "text", [{ id: "x" }], { id: 7 }]) assert.deepEqual(journalReceipt(answer), {}, "An answer that names no record keeps nothing.");
{
  const state = seed();
  appendAudit(state, { actor: "System", role: "Admin", now: "2026-01-01T00:00:00.000Z" }, "test", "workspace", "Synthetic test");
  // JSONB can reorder keys; verification must use the same canonical encoding.
  const audit = state.records.find((record) => record.kind === "audit")!;
  audit.data = Object.fromEntries(Object.entries(audit.data).reverse());
  assert.equal(verifyAudit(state).valid, true);
}
{
  const unchanged = seed();
  assert.doesNotThrow(() => assertFinalState({ merchant: structuredClone(unchanged.merchant), settings: {}, records: [] }, unchanged, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  after.records[0]!.merchantId = "merchant-b";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  after.records.pop();
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const frozen = before.records.find((record) => record.kind === "policies")!;
  frozen.status = "approved";
  const after = structuredClone(before);
  after.records.find((record) => record.id === frozen.id)!.name = "rewritten";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  before.records.push({
    id: "audit-1", merchantId: "merchant-a", kind: "audit", name: "created", status: "recorded",
    reference: "", amountKobo: 0, customerId: "", createdAt: "2028-01-01T00:00:00.000Z", updatedAt: "2028-01-01T00:00:00.000Z",
    data: { sequence: 1, hash: "unchanged" },
  });
  const after = structuredClone(before);
  after.records.find((record) => record.id === "audit-1")!.data.hash = "rewritten";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  const payment = after.records.find((record) => record.kind === "payments" && record.status === "allocated")!;
  const due = after.records.find((record) => record.kind === "due-items" && record.customerId === payment.customerId)!;
  after.records.push({
    id: "new-over-allocation", merchantId: "merchant-a", kind: "allocations", name: "forged allocation",
    status: "confirmed", reference: "", amountKobo: payment.amountKobo, customerId: payment.customerId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    data: { paymentId: payment.id, dueItemId: due.id, synthetic: true },
  });
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}

{
  const before = seed();
  const attempt = before.records.find((record) => record.kind === "attempts")!;
  const after = structuredClone(before);
  const due = after.records.find((record) => record.id === attempt.data.dueItemId)!;
  due.amountKobo += 100000;
  assert.doesNotThrow(() => assertFinalState(before, after, "merchant-a"), "A due edit must not rewrite or invalidate a historical attempt amount.");
  const newAttempt = { ...structuredClone(attempt), id: "new-mismatched-attempt" };
  after.records.push(newAttempt);
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  const before = seed(), after = structuredClone(before);
  after.records[0]!.amountKobo = amount;
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
for (const key of ["policyId", "experimentId", "proposedDueItemId", "noticeId", "settlementBatchId", "statementObservationId", "virtualAccountCustomerId", "linkedRecordId"]) {
  const before = seed(), after = structuredClone(before);
  after.records.find((record) => record.kind === "due-items")!.data[key] = "foreign-or-missing-record";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed(), after = structuredClone(before);
  after.records.push(structuredClone(after.records[0]!));
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
console.log("valopay repository pure guards passed");

{
  const { queueExport, retryExport } = await import("../src/lib/export-jobs");
  const context = { actor: "Sandbox Finance", role: "Finance", now: "2028-01-01T10:00:00.000Z" };
  for (const status of ["failed", "running"] as const) {
    const before = seed();
    const job = queueExport(before, context, { kind: "customers", format: "csv" }, "/private/synthetic");
    const record = before.records.find(row => row.id === job.id)!;
    record.status = status; Object.assign(record.data, { lastError: "Synthetic failure", leaseToken: "old-lease", leaseExpiresAt: "2028-01-01T09:59:59.000Z" });
    const after = structuredClone(before); retryExport(after, context, job.id);
    assert.doesNotThrow(() => assertFinalState(before, after, "merchant-a", context.now));
    for (const key of ["bucket", "objectName", "kind", "format", "requestedBy", "checksum", "attempts"]) {
      const forged = structuredClone(after); forged.records.find(row => row.id === job.id)!.data[key] = "rewritten";
      expectConflict(() => assertFinalState(before, forged, "merchant-a", context.now));
    }
    if (status === "running") expectConflict(() => assertFinalState(before, after, "merchant-a", "2028-01-01T09:00:00.000Z"));
    const ready = structuredClone(before); ready.records.find(row => row.id === job.id)!.status = "ready";
    expectConflict(() => assertFinalState(ready, after, "merchant-a", context.now));
  }
  console.log("Export retry guards passed: failed/expired only, unchanged request and object identity, immutable ready evidence.");
}
