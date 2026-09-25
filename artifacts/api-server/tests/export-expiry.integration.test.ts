// Disposable PostgreSQL only: no object-storage credentials or external calls.
// Saved exports whose file an approved retention run removed are listed as expired, never as completed or needing a retry.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { ValopayRecord } from "../src/domain/types.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the export expiry integration tests.");
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, listRecords, closeDatabase } = await import("../src/lib/valopay-store.js");
const { pageRecords } = await import("../src/lib/valopay-list.js");
const { default: express } = await import("express");
const { default: router } = await import("../src/routes/valopay.js");

const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const token = () => randomBytes(32).toString("hex");
const request = (value: string) => ({ headers: { cookie: `valopay_sandbox=${value}` }, secure: false, auth: auth() }) as any;
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

  console.log("Export expiry integration checks passed: the expired filter, and Completed and Needs retry without expired files.");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  await closeDatabase();
}
