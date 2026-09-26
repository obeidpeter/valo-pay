/** Real HTTP + PostgreSQL regression: a saved outcome is not reusable authority.
 * Declined replay retains its original completed journal/receipt and never reruns
 * the action. All records, identities, grants and external outcomes are synthetic. */
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { requireLoopback } from "./throwaway-database.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to test connected receipt authority on disposable loopback PostgreSQL.");
  process.exit(0);
}
requireLoopback("Connected receipt authority", new URL(process.env.DATABASE_URL!));
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.CLERK_TELEMETRY_DISABLED = "1";
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index.js");
const { errorHandler } = await import("../src/lib/error-handler.js");
const store = await import("../src/lib/valopay-store.js");
const { touch } = await import("../src/domain/records.js");
const quiet = { info() {}, warn() {}, error() {} };
const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { (req as any).auth = auth(); (req as any).log = quiet; next(); });
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
let lender = "", workspaceId = "", checks = 0;
type Answer = { status: number; data: any; operation: string | null };
async function call(path: string, body?: unknown, key?: string): Promise<Answer> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), operation: response.headers.get("X-Valopay-Operation") };
}
const ok = (answer: Answer) => { assert.equal(answer.status, 200, JSON.stringify(answer.data)); return answer.data; };
const q = (path: string) => `${path}?merchantId=${lender}`;
const request = () => ({ headers: { cookie }, query: { merchantId: lender }, secure: false, log: quiet, auth: auth() }) as any;
const response = () => ({ cookie() {} }) as any;
const role = (value: string) => store.inWorkspace(request(), response(), (ctx) => store.changeRole(ctx, value), "persona");
async function fresh(action: string, data: Record<string, unknown> = {}, recordId?: string) {
  const view = ok(await call(q("/v1/connected")));
  const body = { action, data, ...(recordId ? { recordId } : {}), expectedRevision: view.revision, reason: "Verify historical response access without repeating the command" };
  const key = randomUUID(), answer = await call(q("/v1/connected/actions"), body, key);
  ok(answer);
  return { body, key, answer };
}
type Receipt = Awaited<ReturnType<typeof fresh>>;
const snapshot = async () => JSON.stringify([
  (await pool.query("SELECT id, kind, status, data, updated_at FROM valopay_records WHERE merchant_id=$1 ORDER BY id", [lender])).rows,
  (await pool.query("SELECT * FROM valopay_idempotency WHERE merchant_id=$1 ORDER BY id", [lender])).rows,
]);
async function replay(receipt: Receipt, status: number) {
  const before = await snapshot();
  const answer = await call(q("/v1/connected/actions"), receipt.body, receipt.key);
  assert.equal(answer.status, status, JSON.stringify(answer.data));
  assert.equal(await snapshot(), before, "replay never rewrites records, audits or the original idempotency receipt");
  assert.equal(answer.operation, receipt.answer.operation);
  assert.equal((await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [answer.operation])).rows[0].status, "completed");
  assert.notEqual(answer.data.committed, false, "an unavailable historical response must not claim the original action saved nothing");
  if (status === 200) assert.deepEqual(answer.data, receipt.answer.data);
  else {
    assert.match(answer.data.error, /already completed/);
    assert.equal(answer.data.operation, "completed");
    assert.equal("record" in answer.data, false, "no retained score or manifest is disclosed");
  }
  checks += status === 200 ? 6 : 8;
}
async function reviseGrant(id: string, status: string) {
  await store.inWorkspace(request(), response(), async (ctx) => {
    const state = await store.loadState(ctx, lender, "update");
    const grant = state.records.find((r) => r.id === id && r.kind === "connected-consents")!;
    grant.status = status;
    grant.data.version++;
    touch(grant, ctx.now);
    store.appendAudit(state, ctx, "test.permission.revision", grant.id, "Change the synthetic grant to verify receipt replay checks current authority.");
    await store.saveState(ctx, state);
  });
}
try {
  lender = ok(await call("/v1/workspace")).merchants[0].id;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  await role("Operations");
  const readGrant = (await fresh("consent.grant", { subjectId: "sme", purpose: "merchant_account_read" })).answer.data.record;
  const erpGrant = (await fresh("consent.grant", { subjectId: "sme", purpose: "erp_draft" })).answer.data.record;
  await fresh("cash.initialize");
  const forecast = await fresh("cash.forecast");
  assert.ok(forecast.answer.data.record.record.data.replayAuthority.length, "new forecast response and stored record retain original authority");
  await replay(forecast, 200);
  const prepared = (await fresh("cash.erp.prepare")).answer.data.record.record;
  await role("Finance");
  await fresh("cash.erp.review", {}, prepared.id);
  const exported = await fresh("cash.erp.export", {}, prepared.id);
  await replay(exported, 200);
  const vat = await fresh("cash.vat.export");
  assert.equal(vat.answer.data.record.record.data.replayAuthority.length, 2);
  await replay(vat, 200);
  await reviseGrant(erpGrant.id, "revoked");
  await replay(exported, 403);
  await replay(vat, 403);
  await reviseGrant(erpGrant.id, "active");
  await replay(exported, 409);
  await replay(vat, 409);
  await role("Operations");
  await reviseGrant(readGrant.id, "revoked");
  await replay(forecast, 403);
  await reviseGrant(readGrant.id, "active");
  await replay(forecast, 409);

  const customerId = ok(await call(q("/v1/connected"))).customers[0].id;
  const blocked = await fresh("credit.assess", { customerId, scenario: "ready" });
  assert.equal(blocked.answer.data.record.data.result.score, null);
  await replay(blocked, 200);
  await fresh("consent.grant", { subjectId: customerId, purpose: "account_read" });
  const creditGrant = (await fresh("consent.grant", { subjectId: customerId, purpose: "credit_assessment" })).answer.data.record;
  const assessed = await fresh("credit.assess", { customerId, scenario: "ready" });
  assert.ok(assessed.answer.data.record.data.result.score);
  await replay(assessed, 200);
  await reviseGrant(creditGrant.id, "revoked");
  await replay(assessed, 403);
  await replay(blocked, 200);
  checks += 4;
} finally {
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"])
      await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
console.log(`Connected replay PostgreSQL/HTTP: ${checks} checks passed; revoked/replaced authority cannot replay scores or exports, original receipts/journals remain completed and commands never rerun.`);
