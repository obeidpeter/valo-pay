// What the API takes from a request and what it makes of it (audit 23
// September, security item 3 and API items 3, 6, 8 and 11), against a real
// database. An audit entry names the record the request is about and the
// reason the route's own schema carries, never text a client added beside
// them.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to check input semantics against a disposable PostgreSQL database.");
  process.exit(0);
}
// Placeholder identity and storage settings: nothing here reaches the identity provider or object storage.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.PRIVATE_OBJECT_DIR ||= "/input-semantics-bucket/private";
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "Unknown resource.", requestId: "input-semantics" }); });
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, key: string | null = randomUUID()) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key && method !== "GET" ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: (await response.json()) as any };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 800)); return result.data; };
let workspaceId: string | undefined;
let checks = 0;
try {
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id as string;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${lender}`;
  const lastAudit = async () => (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [lender])).rows[0].data as { action: string; objectId: string; summary: string };
  const customers = ok(await call(q("/v1/records/customers?limit=500"))).items as any[];
  const victim = customers[0];

  // ---- 1. An audit entry names what the request changed and the reason its route takes ----
  {
    // A settings change cannot name a customer or carry a reassuring story: neither field is in its schema.
    const settings = ok(await call(q("/v1/settings")));
    ok(await call(q("/v1/settings"), "PATCH", { minimumTicketKobo: 500000, expectedRevision: settings.revision, recordId: victim.id, reason: "Routine review of customer contact preferences; no financial settings changed." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "patch.settings", objectId: "workspace", summary: "Synthetic workspace operation" }, "a settings change is recorded against the lender, in the route's words");
    // A new record is the entry's object, whatever the body names; its data cannot add a note to the summary either.
    const created = ok(await call(q("/v1/records/customers"), "POST", { name: "Audit integrity customer", data: { consentProvenance: "Synthetic fixture", auditNote: "Approved by the board." }, recordId: victim.id, reason: "Corrected the victim's name at their request." }));
    assert.deepEqual(await lastAudit().then(({ objectId, summary }) => ({ objectId, summary })), { objectId: created.id, summary: "Synthetic workspace operation" }, "a created record is the object, and neither the body's reason nor its data's note reaches the summary");
    // An action keeps its own reason, and names the record it applies to only when it acted on it.
    ok(await call(q("/v1/actions"), "POST", { action: "run_reconciliation", recordId: victim.id, reason: "Reconcile the morning's payment evidence." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "run_reconciliation", objectId: "workspace", summary: "Reconcile the morning's payment evidence." }, "an action that ignores recordId does not name the record");
    const mandate = (ok(await call(q("/v1/records/mandates?status=active&limit=1"))).items as any[])[0];
    ok(await call(q("/v1/actions"), "POST", { action: "mandate_suspend", recordId: mandate.id, reason: "The customer asked to pause collections." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "mandate_suspend", objectId: mandate.id, summary: "The customer asked to pause collections." }, "an action names the record it changed, with its reason");
    // A route whose strict schema carries a reason keeps it; the path names the object.
    const fixture = ok(await call(q("/v1/sources/paystack/fixtures"), "POST", { scenario: "payment", syntheticOnly: true }));
    ok(await call(q(`/v1/sources/events/${fixture.event.id}/replay`), "POST", { expectedUpdatedAt: fixture.event.updatedAt, reason: "  Recheck the stored delivery.  " }));
    assert.deepEqual(await lastAudit().then(({ objectId, summary }) => ({ objectId, summary })), { objectId: fixture.event.id, summary: "Recheck the stored delivery." }, "a schema's reason is taken as the schema parsed it");
    assert.equal(ok(await call(q("/v1/actions"), "POST", { action: "verify_audit" })).data.valid, true, "the chain still verifies");
    checks += 6;
  }
} finally {
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
console.log(`Input semantics checks passed (${checks} checks): audit entries name the record a request changed and the reason its route takes.`);
