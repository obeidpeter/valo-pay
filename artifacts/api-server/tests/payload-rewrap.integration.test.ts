// The operator's re-wrap step on PostgreSQL (scripts/rewrap-payloads.ts, rewrapProtectedPayloads): after the
// payload wrapping key changes name, bounded runs re-seal every protected payload (an import batch's source rows
// and check, a journal entry's request and refusal receipt, a replay copy's answer) under the new key, each in
// its own scope, report how many still name an earlier key, and can be run again at any point; a payload a
// request rewrote while the run worked is left to it and checked again; a payload whose key the key service no
// longer opens stops the run with the key named. Once none remain, the earlier key is retired and every view,
// replay and recovery still opens its payloads. The key service is a local fixture that knows each key by name.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on a disposable PostgreSQL database to test the payload re-wrap."); process.exit(0); }
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Refuse a non-local integration database.");
const names = ["VALOPAY_STAFF_ACCESS", "VALOPAY_RUNTIME_ISOLATION", "VALOPAY_PAYLOAD_ENCRYPTION", "VALOPAY_KMS_KEY", "VALOPAY_KMS_PREVIOUS_KEYS"] as const;
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
const key = (name: string) => `projects/synthetic-rewrap/locations/global/keyRings/fixture/cryptoKeys/${name}`;
const [first, second, third] = [key("first"), key("second"), key("third")];
Object.assign(process.env, { VALOPAY_STAFF_ACCESS: "off", VALOPAY_RUNTIME_ISOLATION: "off", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: first });
delete process.env.VALOPAY_KMS_PREVIOUS_KEYS;
const { pool } = await import("@workspace/db");
const { managedWrappingKeys, openPayload, sealPayload } = await import("../src/lib/protected-payloads");
// The key service fixture: one secret per key name; a retired key opens nothing, as a disabled Cloud KMS key would.
const masters = new Map<string, Buffer>([[first, randomBytes(32)]]);
const { wrap: realWrap, unwrap: realUnwrap } = managedWrappingKeys;
let beforeUnwrap: (() => Promise<void>) | undefined;
managedWrappingKeys.wrap = async (name, data, aad) => { const master = masters.get(name); if (!master) throw new Error("key unavailable"); const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, iv); cipher.setAAD(aad); const sealed = Buffer.concat([cipher.update(data), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), sealed]); };
managedWrappingKeys.unwrap = async (name, data, aad) => { const hook = beforeUnwrap; beforeUnwrap = undefined; await hook?.(); const master = masters.get(name); if (!master) throw new Error("key unavailable"); const decipher = createDecipheriv("aes-256-gcm", master, data.subarray(0, 12)); decipher.setAAD(aad); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]); };
const { default: router } = await import("../src/routes/index"), { errorHandler } = await import("../src/lib/error-handler"), store = await import("../src/lib/valopay-store");
const app = express(); app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }); (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, idempotencyKey?: string) { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; }
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
let workspaceId = "", checks = 0;
try {
  const lender = ok(await call("/v1/workspace")).merchants[0].id;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = `?merchantId=${lender}`;
  // Protected payloads of every kind: a keyed save (its journal request and replay answer), a batch (its rows and check, and its own
  // request and answer) and a refused keyed save (its request and its refusal receipt).
  const customerKey = randomUUID(), customerBody = { name: "Re-wrap customer", reference: `REWRAP-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } };
  const customer = ok(await call(`/v1/records/customers${q}`, "POST", customerBody, customerKey));
  const batch = ok(await call(`/v1/pilot/batches${q}`, "POST", { name: "Re-wrap source", kind: "customers", source: "rewrap", sourceBatchId: randomUUID(), csv: "source_row_id,name,reference,consentProvenance\nrow-1,Re-wrap row,REWRAP-ROW-1,Synthetic consent", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true }, randomUUID()));
  assert.equal((await call(`/v1/records/mandates${q}`, "POST", { name: "Refused mandate", customerId: customer.id, amountKobo: 1, data: {} }, randomUUID())).status, 400);
  const envelopes = async () => (await pool.query<{ key: string; n: string }>(`SELECT value->>'key' AS key,count(*) AS n FROM (
      SELECT f.value FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id CROSS JOIN LATERAL (VALUES (r.data->'csv'),(r.data->'check')) f(value) WHERE m.workspace_id=$1 AND r.kind='import-batches'
      UNION ALL SELECT f.value FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id CROSS JOIN LATERAL (VALUES (o.request),(o.receipt)) f(value) WHERE m.workspace_id=$1
      UNION ALL SELECT i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1) payload
    WHERE jsonb_typeof(value)='object' AND value ? 'protectedPayload' GROUP BY 1 ORDER BY 1`, [workspaceId])).rows.map(row => [row.key, Number(row.n)]);
  const sealedFirst = (await envelopes()).find(([name]) => name === first)?.[1] as number;
  assert.equal(sealedFirst, 8, "two for the customer, four for the batch and two for the refusal"); checks += 1;
  assert.equal((await pool.query("SELECT count(*) AS n FROM valopay_operations WHERE merchant_id=$1 AND receipt ? 'protectedPayload'", [lender])).rows[0].n, "1", "the refusal receipt is sealed too"); checks += 1;

  // The key changes name: new payloads are sealed under the second key, and the first stays listed to open the older ones.
  masters.set(second, randomBytes(32));
  Object.assign(process.env, { VALOPAY_KMS_KEY: second, VALOPAY_KMS_PREVIOUS_KEYS: first });
  const rewrap = (limit: number) => store.rewrapProtectedPayloads({ limit, workspaces: [workspaceId] });
  // A payload a request rewrote while the run worked is left to it: the first one opened is sealed afresh behind the run's back.
  beforeUnwrap = async () => {
    const row = (await pool.query("SELECT i.id,i.merchant_id,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND i.response->>'key'=$2 ORDER BY i.merchant_id,i.id LIMIT 1", [workspaceId, first])).rows[0];
    const scope = { lender: row.merchant_id, record: row.id, field: "response" };
    await pool.query("UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2", [row.id, row.merchant_id, await sealPayload(await openPayload(row.response, scope, managedWrappingKeys), scope, first, managedWrappingKeys)]);
  };
  let run = await rewrap(3);
  assert.deepEqual([run.key, run.rewrapped, run.changed, run.remaining, run.remainingByKey], [second, 2, 1, sealedFirst - 2, [{ key: first, payloads: sealedFirst - 2 }]]); checks += 1;
  assert.match(run.message, /Re-sealed 2 protected payloads under .*cryptoKeys\/second; 1 changed while this run worked and will be checked again\. \d+ still name an earlier key: run the command again until none remain/); checks += 1;
  let runs = 1, total = run.rewrapped;
  while (run.remaining && runs < 20) { run = await rewrap(3); total += run.rewrapped; runs += 1; }
  assert.deepEqual([run.remaining, total, run.remainingByKey], [0, sealedFirst, []], "every payload is re-sealed, the one rewritten meanwhile included"); checks += 1;
  assert.match(run.message, /No protected payload names an earlier key: an earlier key may be retired once no backup you may restore still needs it/); checks += 1;
  assert.deepEqual(await envelopes(), [[second, sealedFirst]]); checks += 1;
  const again = await rewrap(3);
  assert.deepEqual([again.rewrapped, again.changed, again.remaining], [0, 0, 0], "running it again changes nothing"); checks += 1;

  // The first key is retired: the views, a replay and a recovery still open every payload under the second.
  masters.delete(first); delete process.env.VALOPAY_KMS_PREVIOUS_KEYS;
  assert.match(ok(await call(`/v1/pilot/batches/${batch.id}${q}`)).batch.data.csv, /Re-wrap row/); checks += 1;
  assert.equal(ok(await call(`/v1/records/customers${q}`, "POST", customerBody, customerKey)).id, customer.id, "the replay copy opens"); checks += 1;
  const journal = ok(await call(`/v1/operations${q}`)).items.find((item: any) => item.recordId === customer.id);
  assert.equal(ok(await call(`/v1/operations/${journal.id}/retry${q}`, "POST", {})).id, customer.id, "the journal request opens"); checks += 1;

  // A payload whose key the key service no longer opens stops the run, naming the key; with the key back, the run finishes.
  masters.set(third, randomBytes(32)); process.env.VALOPAY_KMS_KEY = third;
  ok(await call(`/v1/records/customers${q}`, "POST", { name: "Third key customer", reference: `REWRAP-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } }, randomUUID()));
  const thirdMaster = masters.get(third)!; masters.delete(third); process.env.VALOPAY_KMS_KEY = second;
  await assert.rejects(() => rewrap(10), (error: any) => error.status === 503 && /sealed under .*cryptoKeys\/third could not be opened, so the run stopped after re-sealing 0\. Keep that key in VALOPAY_KMS_PREVIOUS_KEYS/.test(error.message)); checks += 1;
  masters.set(third, thirdMaster);
  assert.equal((await rewrap(10)).remaining, 0); checks += 1;
  // Without a configured key, or on the restricted runtime login, the step refuses before it reads anything.
  process.env.VALOPAY_PAYLOAD_ENCRYPTION = "off";
  await assert.rejects(() => rewrap(1), /Set VALOPAY_PAYLOAD_ENCRYPTION=kms/); checks += 1;
  process.env.VALOPAY_PAYLOAD_ENCRYPTION = "kms";
  await assert.rejects(() => store.rewrapProtectedPayloads({ limit: 1001, workspaces: [workspaceId] }), /between 1 and 1000/); checks += 1;
  console.log(`Payload re-wrap PostgreSQL checks passed (${checks} checks): bounded, resumable re-sealing of every protected payload under a renamed key, a concurrent rewrite left to its request, the remaining count by key, a retired key no view needs, and a stop that names a key the service cannot open.`);
} finally {
  managedWrappingKeys.wrap = realWrap; managedWrappingKeys.unwrap = realUnwrap;
  for (const master of masters.values()) master.fill(0);
  for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  server.close(); await once(server, "close");
  if (workspaceId) { for (const table of ["valopay_operations", "valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]); await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]); await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]); }
  await pool.end();
}
