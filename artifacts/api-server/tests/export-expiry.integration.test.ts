// Disposable PostgreSQL only. Private storage is a fake this suite installs: no object-storage credentials or external calls.
// Saved exports whose file an approved retention run removed are listed as expired, never as completed or needing a retry;
// and an idle anonymous sandbox the sweep deletes loses its export files too, once the deletion has committed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { ValopayRecord } from "../src/domain/types.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the export expiry integration tests.");
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, listRecords, closeDatabase, overrideSweptExportRemoval } = await import("../src/lib/valopay-store.js");
const { pageRecords } = await import("../src/lib/valopay-list.js");
const { default: express } = await import("express");
const { default: router } = await import("../src/routes/valopay.js");
type SweptExportFile = Parameters<Parameters<typeof overrideSweptExportRemoval>[0]>[0];

const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const token = () => randomBytes(32).toString("hex");
const request = (value: string, log?: object) => ({ headers: { cookie: `valopay_sandbox=${value}` }, secure: false, auth: auth(), ...(log ? { log } : {}) }) as any;
const response = () => ({ cookie() {} }) as any;
const bucket = "synthetic-private-bucket";
/** Saves synthetic export jobs straight to the lender's records, as the worker and a retention run would have left them. */
async function saveJobs(merchantId: string, jobs: Array<{ label: string; status: string; removed?: boolean; checksum?: boolean; stored?: boolean }>) {
  const saved: Record<string, string> = {};
  for (const [index, job] of jobs.entries()) {
    const id = randomUUID();
    const data = {
      kind: "customers", format: "json", synthetic: true, attempts: 1,
      ...(job.stored === false ? {} : { bucket, objectName: `synthetic/exports/${merchantId}/${id}.json` }),
      ...(job.checksum ? { checksum: "c".repeat(64), generatedAt: "2026-06-01T09:00:00.000Z", byteLength: 12 } : {}),
      ...(job.status === "failed" ? { lastError: "Synthetic generation failure." } : {}),
      ...(job.removed ? { fileDeletedAt: "2026-09-01T09:00:00.000Z", fileRetentionRunId: randomUUID() } : {}),
    };
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,created_at,updated_at)
      VALUES($1,$2,'exports',$3,$4,'','',$5,$6,$6)`, [id, merchantId, `Synthetic export ${job.label}`, job.status, data, new Date(Date.UTC(2026, 5, 1, 9, index)).toISOString()]);
    saved[job.label] = id;
  }
  return saved;
}
/** Makes a sandbox old and idle enough to sweep, older than any other a reused database may hold, so the next sweep reaches it first. */
async function age(merchantId: string) {
  const workspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '900 days' WHERE id=$1", [workspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '900 days', updated_at = updated_at - interval '900 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [workspace]);
  return workspace;
}
const exists = async (table: string, id: string) => ((await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount || 0) > 0;

let server: Server | undefined;
try {
  // ---- The list's status filter: expired is derived from the file's removal ----
  const listToken = token();
  const merchantId = (await inWorkspace(request(listToken), response(), listMerchants))[0]!.id;
  const jobs = await saveJobs(merchantId, [
    { label: "ready", status: "ready", checksum: true }, { label: "ready removed", status: "ready", checksum: true, removed: true },
    { label: "failed", status: "failed" }, { label: "failed removed", status: "failed", removed: true },
    { label: "queued", status: "queued" }, { label: "running", status: "running" },
  ]);
  const listed = (query: Record<string, unknown>) => inWorkspace(request(listToken), response(), (context) => listRecords(context, merchantId, "exports", query), "read");
  const ids = (page: { items: ValopayRecord[] }) => page.items.map((item) => item.id);
  const everything = await listed({});
  assert.equal(everything.total, 6);
  const expected: Record<string, string[]> = {
    ready: [jobs.ready!], failed: [jobs.failed!], expired: [jobs["failed removed"]!, jobs["ready removed"]!],
    queued: [jobs.queued!], running: [jobs.running!],
  };
  for (const [status, wanted] of Object.entries(expected)) {
    for (const query of [{ status }, { status, search: "Synthetic export" }, { status, limit: 1 }]) {
      const page = await listed(query);
      assert.deepEqual(page, pageRecords(everything.items, query, "exports"), `the database lists as the shared rule does: ${JSON.stringify(query)}`);
      assert.deepEqual(ids(page), query.limit ? wanted.slice(0, 1) : wanted, `${JSON.stringify(query)} lists ${wanted.length} exports`);
      assert.equal(page.total, wanted.length);
    }
  }
  // Through the route, as the console asks for it: the private storage fields stay out of the answer.
  const app = express();
  app.use((req, _res, next) => { (req as any).auth = auth(); (req as any).log = { info() {}, warn() {} }; next(); });
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const answer = await fetch(`http://127.0.0.1:${address.port}/api/v1/records/exports?merchantId=${merchantId}&status=expired`, { headers: { cookie: `valopay_sandbox=${listToken}` } });
  assert.equal(answer.status, 200);
  const page = await answer.json() as { items: ValopayRecord[]; total: number };
  assert.deepEqual([ids(page), page.total], [expected.expired, 2], "the route lists the expired exports");
  assert.ok(page.items.every((item) => item.data.fileDeletedAt && !("bucket" in item.data) && !("objectName" in item.data)), "with their removal time and without their storage location");

  // ---- The sweep removes a swept sandbox's export files from private storage, after its deletion commits ----
  process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP = "on";
  const removals: Array<SweptExportFile & { committed: boolean }> = [];
  let outage = "";
  const restore = overrideSweptExportRemoval(async (file) => {
    // Another connection sees the export's row only while the sweeping transaction is uncommitted.
    removals.push({ ...file, committed: !(await exists("valopay_records", file.exportId)) });
    if (file.exportId === outage) throw new Error("Synthetic private storage outage");
    return "deleted";
  });
  try {
    const staleToken = token();
    const [first, second] = (await inWorkspace(request(staleToken), response(), listMerchants)).map((merchant) => merchant.id).sort();
    const stale = { ...(await saveJobs(first!, [{ label: "ready", status: "ready", checksum: true }, { label: "failed", status: "failed" }, { label: "removed", status: "ready", checksum: true, removed: true }, { label: "never stored", status: "failed", stored: false }])),
      ...Object.fromEntries(Object.entries(await saveJobs(second!, [{ label: "queued", status: "queued" }])).map(([label, id]) => [`second ${label}`, id])) };
    outage = stale.failed!;
    const staleWorkspace = await age(first!);

    // A bootstrap whose own transaction rolls back keeps the sandbox, so none of its files is touched.
    await assert.rejects(inWorkspace(request(token()), response(), async (context) => { await listMerchants(context); throw new Error("Synthetic failure after the sweep"); }), /Synthetic failure after the sweep/);
    assert.equal(await exists("valopay_workspaces", staleWorkspace), true, "a rolled-back bootstrap undoes its sweep");
    assert.deepEqual(removals.filter((file) => [first, second].includes(file.merchantId)), [], "and removes none of the sandbox's files");

    const warnings: Array<Record<string, any>> = [];
    const seeded = await inWorkspace(request(token(), { warn: (fields: object) => warnings.push(fields as Record<string, any>) }), response(), listMerchants);
    assert.equal(seeded.length, 2, "the new visitor is seeded");
    assert.equal(await exists("valopay_workspaces", staleWorkspace), false, "the idle sandbox is swept");
    const swept = removals.filter((file) => [first, second].includes(file.merchantId));
    const objectName = (merchant: string, id: string) => `synthetic/exports/${merchant}/${id}.json`;
    assert.deepEqual(swept.sort((a, b) => a.exportId.localeCompare(b.exportId)), [
      { merchantId: first!, exportId: stale.ready!, bucket, objectName: objectName(first!, stale.ready!), checksum: "c".repeat(64), committed: true },
      { merchantId: first!, exportId: stale.failed!, bucket, objectName: objectName(first!, stale.failed!), committed: true },
      { merchantId: second!, exportId: stale["second queued"]!, bucket, objectName: objectName(second!, stale["second queued"]!), committed: true },
    ].sort((a, b) => a.exportId.localeCompare(b.exportId)), "each of its lenders' stored files is removed once, after the deletion committed; a file retention already removed, or never stored, is not");
    const left = warnings.filter((fields) => fields.event === "workspace.sweep_file_left");
    assert.equal(left.length, 1, JSON.stringify(warnings));
    assert.deepEqual({ ...left[0], err: String(left[0]!.err?.message) }, { event: "workspace.sweep_file_left", reason: "failed", merchantId: first!, exportId: stale.failed!, bucket, objectName: objectName(first!, stale.failed!), err: "Synthetic private storage outage" },
      "a file private storage could not remove is named in the log for an operator");
    assert.deepEqual(warnings.filter((fields) => fields.event === "workspace.sweep_failed"), [], "and the sweep itself stands");
  } finally { restore(); }
  console.log("Export expiry integration checks passed: the expired filter, Completed and Needs retry without expired files, and a swept sandbox's files removed after its deletion commits.");
} finally {
  delete process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP;
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  await closeDatabase();
}
