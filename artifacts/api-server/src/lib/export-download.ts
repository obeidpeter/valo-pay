import type { File } from "@google-cloud/storage";
import { Readable } from "node:stream";

/** One consumer owns buffering, cancellation and cleanup for an export read. */
export const EXPORT_STORAGE_TIMEOUT_MS = 60_000;
export function collectExportBytes(stream: Readable, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024, timeoutMs = EXPORT_STORAGE_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let tearingDown = false;
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
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const bytes = error ? undefined : Buffer.concat(chunks);
      chunks.length = 0;
      // A producer may still be attaching its body pipe inside a response
      // callback. Defer teardown until that callback has returned. Network
      // cancellation belongs to readStorageObject's AbortController; calling
      // retry-request's duck-typed abort() here used to clear its live pipe.
      setImmediate(() => {
        tearingDown = true;
        let failure = error;
        try { stream.destroy(); }
        catch (cause) { failure ??= cause instanceof Error ? cause : new Error(String(cause)); }
        // Keep the error handler through destroy and until close: transport
        // transport errors may still arrive while cancellation is unwinding.
        if (stream.closed) cleanup();
        if (failure) reject(failure); else resolve(bytes!);
      });
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) { finish(new Error('Export download exceeds the supported file size.')); return; }
      chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => {
      if (!settled) finish(new Error("Export download closed before completion."));
      else if (tearingDown) cleanup();
    };
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("Export download cancelled."), { name: "AbortError" }));
    const onResponse = (response: { statusCode?: number }) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        finish(Object.assign(new Error("Export object could not be downloaded."), { statusCode: response.statusCode }));
      }
    };
    stream.on("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.on("response", onResponse);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Export storage request timed out.')), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    stream.on("data", onData);
  });
}

/** Bound the wait for SDK-managed credentials; its underlying token refresh is
 * not cancellable through the public API. A late result never starts a read. */
function beforeAbort<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  pending.then(value=>{signal.removeEventListener('abort',abort);if(!signal.aborted)resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
/** Keep SDK authentication, but avoid its non-cancellable teeny-request read
 * transport. Native fetch aborts before headers and during the response body. */
async function readStorageObject(file:File,media:boolean,signal?:AbortSignal,maxBytes=32*1024*1024,timeoutMs=EXPORT_STORAGE_TIMEOUT_MS):Promise<Buffer>{
 const controller=new AbortController();
 const abort=()=>controller.abort(Object.assign(new Error('Export download cancelled.'),{name:'AbortError'}));
 if(signal?.aborted){abort();throw controller.signal.reason;}
 signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('Export storage request timed out.')),timeoutMs);
 try{
  // Both path segments are encoded independently; a slash, space or question
  // mark in an object name cannot change the endpoint or its query parameters.
  const url=new URL(`/storage/v1/b/${encodeURIComponent(file.bucket.name)}/o/${encodeURIComponent(file.name)}`,file.storage.apiEndpoint);
  if(media)url.searchParams.set('alt','media');
  const authHeaders=await beforeAbort(file.storage.authClient.getRequestHeaders(url.toString()),controller.signal);
  controller.signal.throwIfAborted();
  const headers=new Headers(authHeaders);headers.set('Accept-Encoding','identity');headers.set('Cache-Control','no-store');
  const response=await globalThis.fetch(url,{headers,signal:controller.signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Export object could not be downloaded.'),{statusCode:response.status});}
  if(!response.body)throw new Error('Export storage response has no body.');
  const stream=Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  return await collectExportBytes(stream,controller.signal,maxBytes,timeoutMs);
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
export function readExportBytes(file:File,signal?:AbortSignal,maxBytes?:number,timeoutMs?:number):Promise<Buffer>{
 // The caller verifies SHA-256 before returning these immutable artifact bytes.
 return readStorageObject(file,true,signal,maxBytes,timeoutMs);
}
export async function readExportMetadata(file:File,signal?:AbortSignal,timeoutMs?:number):Promise<Record<string,any>>{
 return JSON.parse((await readStorageObject(file,false,signal,256*1024,timeoutMs)).toString('utf8'));
}
/** Delete only the observed generation of this lender's immutable export.
 * A timed-out/lost acknowledgement is retried by reading metadata first. */
export async function deleteRetainedExport(file:File,expected:{id:string;merchantId:string;checksum?:string}):Promise<'deleted'|'already_absent'>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{
  let metadata:Record<string,any>;
  try{metadata=await readExportMetadata(file,controller.signal,8000);}catch(error){if((error as any).statusCode===404)return 'already_absent';throw error;}
  const custom=metadata.metadata||{};
  if(custom.valopayExportId!==expected.id||custom.valopayMerchantId!==expected.merchantId||!/^\d+$/.test(String(metadata.generation)))throw new Error('Export ownership or generation could not be verified.');
  if(expected.checksum){let artifact;try{artifact=JSON.parse(String(custom.valopayArtifact));}catch{throw new Error('Export artifact metadata is invalid.');}if(artifact?.checksum!==expected.checksum)throw new Error('Export checksum metadata changed.');}
  const url=new URL(`/storage/v1/b/${encodeURIComponent(file.bucket.name)}/o/${encodeURIComponent(file.name)}`,file.storage.apiEndpoint);
  url.searchParams.set('ifGenerationMatch',String(metadata.generation));
  const headers=await beforeAbort(file.storage.authClient.getRequestHeaders(url.toString()),controller.signal);
  const response=await globalThis.fetch(url,{method:'DELETE',headers,signal:controller.signal,redirect:'error'});
  await response.body?.cancel();
  if(response.status===404)return 'already_absent';
  if(!response.ok)throw new Error('The export generation could not be deleted.');
  return 'deleted';
 }finally{clearTimeout(timer);controller.abort();}
}
