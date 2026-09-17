import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { File } from "@google-cloud/storage";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1" || process.env.NODE_ENV !== "development") {
  throw new Error("Export integration checks require explicit development opt-in.");
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, loadState, saveState, appendAudit } = await import("../src/lib/valopay-store.js");
const { createExportFile, downloadExport } = await import("../src/lib/valopay-exports.js");
const warnings: Array<{ type?: string; count?: number; stack?: string }> = [];
const streams: Array<WeakRef<NodeJS.ReadableStream>> = [];
const originalRead = File.prototype.requestStream;
let peakListeners = 0;
File.prototype.requestStream = function (...args) {
  const stream = originalRead.apply(this, args);
  if (args[0].qs?.alt === "media") {
    streams.push(new WeakRef(stream));
    stream.on("newListener", (event) => {
      if (event === "error" || event === "close") peakListeners = Math.max(peakListeners, stream.listenerCount(event) + 1);
    });
  }
  return stream;
};
const onWarning = (warning: Error & { type?: string; count?: number }) => {
  if (warning.name === "MaxListenersExceededWarning") {
    warnings.push({ type: warning.type, count: warning.count, stack: warning.stack });
  }
};
process.on("warning", onWarning);
const auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const req = { auth, headers: { cookie: `valopay_sandbox=${randomBytes(32).toString("hex")}` }, secure: false } as any;
const res = { cookie() {} } as any;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const repetitions = Number(process.env.VALOPAY_EXPORT_REPETITIONS || 16);

try {
  const fixture = await inWorkspace(req, res, async (context) => {
    const merchants = await listMerchants(context);
    const state = await loadState(context, merchants[0]!.id);
    const customer = state.records.find((record) => record.kind === "customers")!;
    const exported = await createExportFile(state, context, { kind: "customer-pack", customerId: customer.id, format: "pdf" });
    appendAudit(state, context, "test.export-created", exported.id, "Fresh synthetic export stream regression fixture");
    await saveState(context, state);
    return { state, id: exported.id, checksum: exported.checksum, sibling: merchants[1]!.id };
  });
  const originalMetadata = structuredClone(fixture.state.records.find((record) => record.id === fixture.id));
  const measurements: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const result = await downloadExport(fixture.state, fixture.id);
    assert.equal(result.bytes.subarray(0, 4).toString(), "%PDF");
    assert.equal(hash(result.bytes), fixture.checksum);
    assert.equal(result.contentType, "application/pdf");
    await delay(10);
    global.gc?.();
    measurements.push(process.memoryUsage().heapUsed);
  }
  const siblingState = await inWorkspace(req, res, (context) => loadState(context, fixture.sibling));
  const readsBeforeDenial = streams.length;
  await assert.rejects(() => downloadExport(siblingState, fixture.id), (error: any) => error.status === 404);
  assert.equal(streams.length, readsBeforeDenial, "Denied exports must not touch object storage.");
  const corruptMetadata = structuredClone(fixture.state);
  corruptMetadata.records.find((record) => record.id === fixture.id)!.data.checksum = "incorrect";
  await assert.rejects(() => downloadExport(corruptMetadata, fixture.id), /checksum verification failed/);
  assert.deepEqual(fixture.state.records.find((record) => record.id === fixture.id), originalMetadata);
  await inWorkspace(req, res, async (context) => {
    const persisted = await loadState(context, fixture.state.merchant.id);
    assert.deepEqual(persisted.records.find((record) => record.id === fixture.id), originalMetadata, "Downloads must not rewrite stored export metadata.");
  });
  await delay(100);
  global.gc?.();
  await delay(10);
  const retained = streams.map((ref) => ref.deref()).filter((stream) => stream !== undefined);
  console.log(JSON.stringify({
    downloads: repetitions,
    streamCount: streams.length,
    retainedStreams: retained.length,
    peakListeners,
    retainedListeners: retained.map((stream) => ({ error: stream.listenerCount("error"), close: stream.listenerCount("close") })),
    heapGrowthBytes: measurements.at(-1)! - measurements[Math.min(3, measurements.length - 1)]!,
    listenerWarnings: warnings.length,
    firstWarning: warnings[0],
  }, null, 2));
  assert.equal(warnings.length, 0, "Downloads must not accumulate stream listeners.");
  assert.equal(streams.length, repetitions + 1, "Every allowed download must open exactly one media request.");
  assert.ok(peakListeners <= 10);
  if (global.gc) assert.equal(retained.length, 0, "Completed requests must be collectable.");
  assert.ok(measurements.at(-1)! - measurements[Math.min(3, measurements.length - 1)]! < 16 * 1024 * 1024, "Retained heap must remain bounded after warm-up.");
  console.log("Export stream integration checks passed.");
} finally {
  File.prototype.requestStream = originalRead;
  process.off("warning", onWarning);
  await pool.end();
}