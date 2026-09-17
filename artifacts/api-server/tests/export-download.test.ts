import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import { collectExportBytes, readExportBytes } from "../src/lib/export-download.js";

function fixture() {
  const stream = new PassThrough();
  const signal = new AbortController();
  // Existing observers must not be removed by the collector.
  const observer = () => {};
  stream.on("error", observer);
  const clean = () => {
    for (const event of ["data", "end", "close", "response"]) assert.equal(stream.listenerCount(event), 0, event);
    assert.deepEqual(stream.listeners("error"), [observer]);
    assert.equal(getEventListeners(signal.signal, "abort").length, 0);
    assert.equal(stream.destroyed, true);
  };
  return { stream, signal, clean };
}

for (let i = 0; i < 100; i++) {
  const { stream, signal, clean } = fixture();
  const pending = collectExportBytes(stream, signal.signal);
  stream.emit("response", { statusCode: 200 });
  stream.write(Buffer.from([0, 255, 128, 65]));
  stream.end("end");
  assert.deepEqual(await pending, Buffer.from([0, 255, 128, 65, 101, 110, 100]));
  clean();
}
for (const outcome of ["error", "close", "abort", "http-error"] as const) {
  const { stream, signal, clean } = fixture();
  const pending = collectExportBytes(stream, signal.signal);
  stream.write("partial bytes must never escape");
  if (outcome === "error") stream.destroy(new Error("storage failed"));
  if (outcome === "close") stream.destroy();
  if (outcome === "abort") signal.abort();
  if (outcome === "http-error") stream.emit("response", { statusCode: 404 });
  await assert.rejects(pending);
  clean();
}
{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readExportBytes({ requestStream() { throw new Error("must not start"); } } as any, controller.signal), { name: "AbortError" });
}
console.log("Export collector checks passed: binary bytes, repeated cleanup, errors, premature close, HTTP denial and cancellation.");