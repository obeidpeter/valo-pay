import type { File } from "@google-cloud/storage";
import type { Readable } from "node:stream";

/** One consumer owns buffering, cancellation and cleanup for an export read. */
export const EXPORT_STORAGE_TIMEOUT_MS = 60_000;
export function collectExportBytes(stream: Readable, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024, timeoutMs = EXPORT_STORAGE_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let length = 0;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.off("response", onResponse);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        chunks.length = 0;
        (stream as Readable & { abort?: () => void }).abort?.();
        // Do not emit a second error after removing our own error handler.
        stream.destroy();
        reject(error);
      } else {
        const bytes = Buffer.concat(chunks);
        chunks.length = 0;
        stream.destroy();
        resolve(bytes);
      }
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) { finish(new Error('Export download exceeds the supported file size.')); return; }
      chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => { if (!settled) finish(new Error("Export download closed before completion.")); };
    const onAbort = () => finish(Object.assign(new Error("Export download cancelled."), { name: "AbortError" }));
    const onResponse = (response: { statusCode?: number }) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        finish(Object.assign(new Error("Export object could not be downloaded."), { statusCode: response.statusCode }));
      }
    };
    stream.once("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.on("response", onResponse);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Export storage request timed out.')), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    stream.on("data", onData);
  });
}

export function readExportBytes(file: File, signal?: AbortSignal, maxBytes?: number): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Export download cancelled."), { name: "AbortError" }));
  // File.download/createReadStream adds another pipeline to the raw response
  // already piped by teeny-request. Use the same authenticated/retrying SDK
  // transport once, then our own collector. The caller verifies the immutable
  // export's SHA-256 before returning any bytes; never use this without it.
  const stream = file.requestStream({
    uri: "",
    qs: { alt: "media" },
    headers: { "Accept-Encoding": "identity", "Cache-Control": "no-store" },
    timeout: EXPORT_STORAGE_TIMEOUT_MS,
  });
  return collectExportBytes(stream, signal, maxBytes);
}
