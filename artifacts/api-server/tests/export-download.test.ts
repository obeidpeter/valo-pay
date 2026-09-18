import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { collectExportBytes, readExportBytes, readExportMetadata } from "../src/lib/export-download.js";

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
{
 const {stream,signal,clean}=fixture();
 const pending=collectExportBytes(stream,signal.signal,4);
 stream.write('12345');
 await assert.rejects(pending,/supported file size/);clean();
}
{
 const {stream,signal,clean}=fixture();
 await assert.rejects(collectExportBytes(stream,signal.signal,100,5),/timed out/);
 clean();
}
// Use the same retry-request implementation that the installed storage SDK
// uses. Its onResponse emits response then accesses delayStream.pipe. Aborting
// synchronously in that event used to clear delayStream and crash the process.
const require=createRequire(import.meta.url);
const retryRequest=createRequire(require.resolve('@google-cloud/storage'))('retry-request');
for(const statusCode of [404,403,500,200]){
 const source=new PassThrough();
 const stream=retryRequest({uri:'http://synthetic.invalid/export'}, {request:()=>source,retries:0,noResponseRetries:0});
 const pending=collectExportBytes(stream);
 assert.doesNotThrow(()=>source.emit('response',{statusCode}),'SDK response callback must finish attaching its body pipe before teardown');
 source.end(statusCode===200?Buffer.from([0,255,128,65]):'Denied object bytes must never be returned');
 if(statusCode===200)assert.deepEqual(await pending,Buffer.from([0,255,128,65]));
 else await assert.rejects(pending,(error:any)=>error.statusCode===statusCode);
 assert.equal(stream.destroyed,true);
 assert.equal(stream.listenerCount('error'),0);
 assert.equal(stream.listenerCount('response'),0);
}
{
 const {stream,signal,clean}=fixture();
 const destroy=stream.destroy.bind(stream);
 stream.destroy=()=>{
  stream.emit('error',new Error('Destroy emitted another transport error.'));
  process.nextTick(()=>stream.emit('error',new Error('Transport error while close is pending.')));
  return destroy();
 };
 const pending=collectExportBytes(stream,signal.signal);
 stream.emit('response',{statusCode:403});
 await assert.rejects(pending,(error:any)=>error.statusCode===403,'original HTTP denial survives secondary teardown errors');
 clean();
}
{
 const source=new PassThrough();
 const stream=retryRequest({uri:'http://synthetic.invalid/export'},{request:()=>source,retries:0,noResponseRetries:0});
 const controller=new AbortController();const pending=collectExportBytes(stream,controller.signal);
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 assert.doesNotThrow(()=>source.emit('response',{statusCode:200}),'a late response cannot encounter an aborted SDK pipe');
 source.end('late bytes');
}
// Exercise native fetch with a local HTTP server, including response headers
// arriving after cancellation. No storage credentials or external network.
const requests:Array<{path:string;authorization:string|undefined}>=[];
let entered:()=>void=()=>{},closed=0;
const server=createServer((req,res)=>{
 requests.push({path:req.url!,authorization:req.headers.authorization});
 const path=new URL(req.url!,'http://local');
 if(path.pathname.includes('delayed')){
  req.once('close',()=>{closed++;});entered();
  setTimeout(()=>{res.writeHead(200);res.end('late response');},80);return;
 }
 if(path.pathname.includes('body-stall')){
  req.once('close',()=>{closed++;});res.writeHead(200);res.write('partial');entered();return;
 }
 const status=path.pathname.includes('missing')?404:path.pathname.includes('denied')?403:200;
 res.writeHead(status,{'Content-Type':path.searchParams.has('alt')?'application/octet-stream':'application/json'});
 res.end(status===200?(path.searchParams.has('alt')?Buffer.from([0,255,128,65]):JSON.stringify({size:'4',metadata:{fixture:'synthetic'}})):'private error body');
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');
const endpoint=`http://127.0.0.1:${address.port}`;
const file=(name:string,getHeaders:()=>Promise<Headers>=async()=>new Headers({authorization:'Bearer synthetic-fixture'}))=>({name,bucket:{name:'synthetic bucket'},storage:{apiEndpoint:endpoint,authClient:{getRequestHeaders:getHeaders}}}) as any;
try{
 const fixture=file('folder/space ?#é.pdf');
 assert.deepEqual(await readExportMetadata(fixture),{size:'4',metadata:{fixture:'synthetic'}});
 assert.deepEqual(await readExportBytes(fixture),Buffer.from([0,255,128,65]));
 assert.match(requests[0]!.path,/synthetic%20bucket\/o\/folder%2Fspace%20%3F%23%C3%A9.pdf$/);
 assert.equal(requests[1]!.path,`${requests[0]!.path}?alt=media`);
 assert.equal(requests[0]!.authorization,'Bearer synthetic-fixture');
 for(const [name,statusCode] of [['missing',404],['denied',403]] as const)await assert.rejects(readExportMetadata(file(name)),(error:any)=>error.statusCode===statusCode);
 await assert.rejects(readExportBytes(file('too-large'),undefined,2),/supported file size/);
 for(const name of ['delayed','body-stall']){
  let sawRequest!:()=>void;const started=new Promise<void>(resolve=>{sawRequest=resolve;});entered=sawRequest;
  const controller=new AbortController();const pending=readExportBytes(file(name),controller.signal);
  await started;await delay(5);controller.abort();await assert.rejects(pending,{name:'AbortError'});
  await delay(100); // The delayed server sends headers after the request ended.
 }
 assert.ok(closed>=2,'native abort closes both pre-header and in-body requests');
 await assert.rejects(readExportMetadata(file('delayed-timeout'),undefined,5),/timed out/);
 await delay(100);
 const countBeforeAuthTimeout=requests.length;
 let resolveAuth!:(headers:Headers)=>void;
 const authHeaders=new Promise<Headers>(resolve=>{resolveAuth=resolve;});
 await assert.rejects(readExportBytes(file('late-auth',()=>authHeaders),undefined,undefined,5),/timed out/);
 resolveAuth(new Headers({authorization:'Bearer synthetic-fixture'}));await delay(20);
 assert.equal(requests.length,countBeforeAuthTimeout,'timed-out authentication never starts a late storage request');
}finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
console.log("Export collector/native transport checks passed: cleanup, SDK callback ordering, late errors, encoded authenticated reads, 404/403, size bounds, pre-header/body cancellation and authentication/read deadlines.");
