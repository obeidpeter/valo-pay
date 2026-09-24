// A lender's history stays out of what each request loads (audit of 23
// September 2026, item 32, decisions 6 and 8), against a real database. The
// audit chain is kept in valopay_records but is not part of a loaded state: a
// write continues it from the head in the lender's settings, verifying the
// entries since the last verified one, so an entry another writer appended
// without moving the head is followed, never forked. The overview checks the
// chain from that point and shows the eight latest entries; verify_audit
// checks it whole and records how far it held. Every load has earlier closes
// as summaries, settings read only the latest close, and a list of a kind that
// grows with history is capped when it names no limit.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to check a lender's history against a disposable PostgreSQL database.");
  process.exit(0);
}
// A placeholder identity key: nothing here reaches the identity provider.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valopay-store");
const { auditEntryData, verifyAuditChain } = await import("../src/lib/digests");
const { exportJobRepository } = await import("../src/lib/export-job-store");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, key?: string) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: (await response.json()) as any };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const sandboxRequest = () => ({ headers: { cookie }, query: {}, secure: false, log: quiet, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const response = { cookie() {} } as any;
type Entry = { id: string; data: Record<string, any>; created_at: Date };
const entriesOf = async (lender: string) => (await pool.query<Entry>("SELECT id,data,created_at FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int,created_at,id", [lender])).rows;
const chainOf = async (lender: string) => (await pool.query<{ chain: Record<string, any> | null }>("SELECT settings->'auditChain' AS chain FROM valopay_merchants WHERE id=$1", [lender])).rows[0]!.chain;
const customer = (name: string) => ({ name, reference: `HISTORY-${randomUUID()}`, data: { consentProvenance: "Synthetic fixture" } });
const brokenAlert = (overview: any) => overview.alerts.some((alert: { key: string }) => alert.key === "audit_chain_broken");
let workspaceId: string | undefined;
let checks = 0;
try {
  const [lender, other] = ok(await call("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string, string];
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string, merchantId = lender) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${merchantId}`;
  const verify = async (merchantId = lender) => ok(await call(q("/v1/actions", merchantId), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data;

  // ---- 1. The chain is not loaded; a write continues it from the head kept on the lender ----
  {
    const seeded = await chainOf(lender);
    assert.equal(seeded?.sequence, 1, "a new lender's settings carry the head of its first entry");
    for (let index = 0; index < 10; index++) ok(await call(q("/v1/records/customers"), "POST", customer(`History customer ${index}`), randomUUID()));
    const entries = await entriesOf(lender), head = entries.at(-1)!;
    assert.deepEqual(verifyAuditChain(entries), { valid: true, count: 11, headHash: head.data.hash }, "eleven entries, one chain");
    const chain = await chainOf(lender);
    assert.deepEqual([chain?.sequence, chain?.hash, chain?.at], [11, head.data.hash, head.created_at.toISOString()], "the lender keeps the chain's head");
    assert.deepEqual([chain?.verified.sequence, chain?.verified.hash], [10, entries.at(-2)!.data.hash], "and the last entry a write read back and verified");
    const loaded = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.loadState(ctx, lender, "share"), "read");
    assert.equal(loaded.records.some((record) => record.kind === "audit"), false, "a read loads none of the chain");
    const written = await store.inWorkspace({ ...sandboxRequest(), query: { merchantId: lender } }, response, async (ctx) => {
      const state = await store.loadState(ctx, lender);
      return state.records.some((record) => record.kind === "audit");
    });
    assert.equal(written, false, "nor does a write");
    checks += 6;
  }

  // ---- 2. The overview shows the eight latest entries, newest first, and checks the chain from the last verified entry ----
  {
    const overview = ok(await call(q("/v1/overview")));
    const latest = (await pool.query<{ id: string }>("SELECT id FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY created_at DESC,id LIMIT 8", [lender])).rows.map((row) => row.id);
    assert.deepEqual(overview.activity.map((entry: { id: string }) => entry.id), latest, "the activity is the eight latest entries, read with a bounded query");
    assert.equal(overview.activity[0].data.sequence, 11);
    assert.equal(brokenAlert(overview), false);
    checks += 3;
  }

  // ---- 3. An entry appended without moving the stored head (the export worker, an earlier build) is followed, never forked ----
  {
    const [head] = (await entriesOf(lender)).slice(-1);
    const data = auditEntryData({ sequence: 12, actor: "System · export worker", action: "export.started", objectId: "history-export", summary: "Appended without moving the stored head.", previousHash: head!.data.hash, timestamp: new Date().toISOString() });
    await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data) VALUES($1,$2,'audit',$3,'recorded','',0,'',$4)", [randomUUID(), lender, data.action, data]);
    assert.equal((await chainOf(lender))?.sequence, 11, "the stored head did not move");
    assert.equal(brokenAlert(ok(await call(q("/v1/overview")))), false, "the overview follows the entry");
    ok(await call(q("/v1/records/customers"), "POST", customer("After an entry from elsewhere"), randomUUID()));
    const entries = await entriesOf(lender);
    assert.deepEqual(entries.map((entry) => entry.data.sequence), Array.from({ length: 13 }, (_, index) => index + 1), "the write took the next sequence after it");
    assert.deepEqual(verifyAuditChain(entries), { valid: true, count: 13, headHash: entries.at(-1)!.data.hash });
    assert.deepEqual(await verify(), { valid: true, count: 13, headHash: entries.at(-1)!.data.hash }, "verify_audit checks the whole stored chain");
    checks += 5;
  }

  // ---- 4. A change to a recent entry shows at once; one before the last verified entry only once the whole chain is checked ----
  {
    for (let index = 0; index < 3; index++) ok(await call(q("/v1/records/customers", other), "POST", customer(`Other lender customer ${index}`), randomUUID()));
    assert.equal(brokenAlert(ok(await call(q("/v1/overview", other)))), false);
    const [second] = (await entriesOf(other)).filter((entry) => entry.data.sequence === 2);
    await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{summary}','\"Rewritten after the fact\"') WHERE id=$1", [second!.id]);
    assert.equal(brokenAlert(ok(await call(q("/v1/overview", other)))), false, "an entry before the last verified one is not re-read by the overview");
    const checked = await verify(other);
    assert.deepEqual([checked.valid, checked.count, checked.headHash], [false, 4, (await entriesOf(other))[0]!.data.hash], "verify_audit walks the whole chain and stops at the changed entry");
    const overview = ok(await call(q("/v1/overview", other)));
    assert.equal(brokenAlert(overview), true, "from then on the overview reports the break, from the point the chain held to");
    assert.equal((await chainOf(other))?.verified.sequence, 1, "the lender records how far the chain held");
    ok(await call(q("/v1/records/customers", other), "POST", customer("Written on a broken chain"), randomUUID()));
    assert.equal(brokenAlert(ok(await call(q("/v1/overview", other)))), true, "and a later write does not hide it");
    checks += 6;
  }

  // ---- 5. A missing latest entry is a break, and its sequence is not issued again ----
  {
    const before = await entriesOf(lender), last = before.at(-1)!;
    await pool.query("DELETE FROM valopay_records WHERE id=$1", [last.id]);
    assert.equal(brokenAlert(ok(await call(q("/v1/overview")))), true, "the stored head is further on than any entry");
    ok(await call(q("/v1/records/customers"), "POST", customer("After a deleted entry"), randomUUID()));
    const after = await entriesOf(lender);
    assert.equal(after.at(-1)!.data.sequence, last.data.sequence + 1, "the next entry follows the stored head");
    assert.equal(verifyAuditChain(after).valid, false);
    assert.equal((await verify()).valid, false);
    checks += 4;
  }

  // ---- 6. A lender with no stored position (an earlier build's) is checked whole, and its first write records it ----
  {
    const token = randomBytes(32).toString("hex"), legacyCookie = `valopay_sandbox=${token}`;
    const legacyCall = async (path: string, method = "GET", body?: unknown, key?: string) => {
      const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: legacyCookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: answer.status, data: (await answer.json()) as any };
    };
    const [legacy] = ok(await legacyCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    try {
      await pool.query("UPDATE valopay_merchants SET settings=settings-'auditChain' WHERE id=$1", [legacy]);
      assert.equal(brokenAlert(ok(await legacyCall(`/v1/overview?merchantId=${legacy}`))), false, "the overview checks a chain without a stored position from its first entry");
      ok(await legacyCall(`/v1/records/customers?merchantId=${legacy}`, "POST", customer("First write after the upgrade"), randomUUID()));
      const chain = await chainOf(legacy), entries = await entriesOf(legacy);
      assert.deepEqual([chain?.sequence, chain?.verified.sequence, verifyAuditChain(entries).valid], [2, 1, true], "the first write records where the chain stands");
    } finally {
      const legacyWorkspace = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [legacy])).rows[0].workspace_id;
      for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [legacyWorkspace]);
      await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [legacyWorkspace]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [legacyWorkspace]);
    }
    checks += 2;
  }

  // ---- 7. Every load has earlier closes as summaries; settings read only the latest close; the close history opens any close whole ----
  {
    const report = { unallocated: { count: 1, kobo: 5, olderThan24Hours: 0 }, exceptions: { openAtClose: 2, overdueAtClose: 1 }, customerPositionsChanged: Array.from({ length: 100 }, (_, index) => ({ customerId: `c${index}`, note: "x".repeat(100) })) };
    for (const [suffix, days] of [["old", 40], ["latest", 0]] as const) {
      await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,'closes',$1,'completed','',0,'',$3,now()-make_interval(days=>$4),now()-make_interval(days=>$4))",
        [`${lender}-history-${suffix}`, lender, { summary: suffix, closedAt: new Date(Date.now() - days * 86_400_000).toISOString(), report, operational: { rows: 1 }, synthetic: true }, days]);
    }
    const reports = ok(await call(q("/v1/reports")));
    const old = reports.closes.find((close: { id: string }) => close.id === `${lender}-history-old`);
    assert.deepEqual([old.data.report.customerPositionsChanged, old.data.operational, old.data.report.unallocated], [undefined, undefined, report.unallocated], "a read has an earlier close as its summary");
    assert.equal(reports.closes.find((close: { id: string }) => close.id === `${lender}-history-latest`).data.report.customerPositionsChanged.length, 100, "and the latest week's whole");
    assert.equal(ok(await call(q(`/v1/close-history/${lender}-history-old`))).data.report.customerPositionsChanged.length, 100, "the close history opens it whole");
    const settings = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.loadSettingsView(ctx, lender), "read");
    assert.deepEqual(settings.records.filter((record) => record.kind === "closes").map((record) => record.id), [`${lender}-history-latest`], "settings read only the latest close");
    assert.equal(ok(await call(q("/v1/settings"))).closeSchedule.lastAt, new Date(Date.parse(reports.closes.find((close: { id: string }) => close.id === `${lender}-history-latest`).data.closedAt)).toISOString(), "and still show when it ran");
    checks += 5;
  }

  // ---- 8. A list of a kind that grows with history is capped without a limit; other kinds are not ----
  {
    const at = Date.now();
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
      SELECT $1||'-notice-'||i,$2,'notifications','Synthetic notice '||i,'submitted','',0,'','{"synthetic":true}',to_timestamp(($3::bigint-i*1000)/1000.0),to_timestamp(($3::bigint-i*1000)/1000.0) FROM generate_series(1,520) i`, [lender, lender, at]);
    const capped = ok(await call(q("/v1/records/notifications")));
    assert.deepEqual([capped.items.length, capped.total, capped.nextOffset], [500, 520, 500], "the newest 500, the total and where to go on");
    const rest = ok(await call(q("/v1/records/notifications?offset=500")));
    assert.deepEqual([rest.items.length, rest.nextOffset], [20, undefined], "the next page holds the rest");
    const customers = ok(await call(q("/v1/records/customers")));
    assert.equal(customers.items.length, customers.total, "a kind that grows with the book returns its whole filtered set");
    checks += 3;
  }

  // ---- 9. The export worker's entries follow the stored head as a request's do: a missing entry's sequence is never issued again ----
  {
    const workerCookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`, directory = process.env.PRIVATE_OBJECT_DIR;
    const workerCall = async (path: string, method = "GET", body?: unknown, key?: string) => {
      const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: workerCookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: answer.status, data: (await answer.json()) as any };
    };
    const [target] = ok(await workerCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    process.env.PRIVATE_OBJECT_DIR = "/private/synthetic-history-tests";
    try {
      const job = ok(await workerCall(`/v1/exports?merchantId=${target}`, "POST", { kind: "gate-pack", format: "json" }, randomUUID()));
      const queued = (await entriesOf(target)).at(-1)!;
      assert.equal((await chainOf(target))?.sequence, queued.data.sequence, "the queued export's entry is the stored head");
      await pool.query("DELETE FROM valopay_records WHERE id=$1", [queued.id]);
      assert.ok(await exportJobRepository.claim(target, job.id), "the export worker claims the job");
      const started = (await entriesOf(target)).at(-1)!;
      assert.deepEqual([started.data.action, started.data.sequence, started.data.previousHash], ["export.started", queued.data.sequence + 1, queued.data.hash], "its entry follows the stored head, not the entry before the missing one");
      assert.equal(verifyAuditChain(await entriesOf(target)).valid, false, "so the gap stays in the chain");
      assert.equal(brokenAlert(ok(await workerCall(`/v1/overview?merchantId=${target}`))), true, "and the overview reports it");
    } finally {
      if (directory === undefined) delete process.env.PRIVATE_OBJECT_DIR; else process.env.PRIVATE_OBJECT_DIR = directory;
      const targetWorkspace = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [target])).rows[0].workspace_id;
      for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [targetWorkspace]);
      await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [targetWorkspace]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [targetWorkspace]);
    }
    checks += 5;
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
console.log(`Lender history checks passed (${checks} checks): the audit chain stays out of every load and continues from the head kept on the lender, entries written elsewhere are followed, the overview checks from the last verified entry and verify_audit the whole chain, earlier closes load as summaries, settings read only the latest close, history lists are capped, and the export worker's entries follow the stored head.`);
